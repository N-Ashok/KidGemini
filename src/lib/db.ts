// SQLite persistence. Single responsibility: store + query alerts and usage events.
// Implements the AlertStore and UsageStore interfaces (Dependency Inversion). Server-only.

import "server-only";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { AlertStore, ParentAlert } from "@/types/alert.types";
import type {
  UsageEvent,
  UsageStore,
  UsageSummary,
} from "@/types/usage.types";
import type { IpLimitRecord, RateLimitStatus, RateLimitStore } from "@/types/rate-limit.types";
import type { ParentAuthRecord, ParentAuthStore } from "@/types/parent-auth.types";
import type { PaymentRecord, PaymentStore } from "@/types/billing.types";
import { evaluate } from "./rate-limit";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const path = process.env.DATABASE_PATH ?? "./data/kidgemini.db";
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL,
      origin TEXT NOT NULL,
      category TEXT,
      severity TEXT NOT NULL,
      action TEXT NOT NULL,
      triggerText TEXT NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL,
      userId TEXT NOT NULL,
      userLabel TEXT,
      model TEXT NOT NULL,
      kind TEXT NOT NULL,
      promptTokens INTEGER NOT NULL,
      outputTokens INTEGER NOT NULL,
      costUsd REAL NOT NULL,
      ip TEXT, country TEXT, region TEXT, city TEXT,
      requestText TEXT NOT NULL,
      outputText TEXT NOT NULL,
      blocked INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_createdAt ON usage_events(createdAt);
    -- Speeds up the guest-gate tally (tokensUsedByUser): per-user lookups instead of a full scan.
    -- See docs/SCALABILITY_ISSUES.md #2.
    CREATE INDEX IF NOT EXISTS idx_usage_userId ON usage_events(userId, createdAt);
    -- Per-IP guest tally (gate.config IP_GUEST_TOKEN_CAP): the cookie-clearing backstop.
    CREATE INDEX IF NOT EXISTS idx_usage_ip ON usage_events(ip);
    -- Per-IP rate-limit state (docs/SCALABILITY_ISSUES.md #3). Persists so a block lasts until
    -- next day and strikes are remembered across days for the 3-strike pay wall.
    CREATE TABLE IF NOT EXISTS ip_limits (
      ip TEXT PRIMARY KEY,
      windowStart INTEGER NOT NULL,
      count INTEGER NOT NULL,
      blockedUntil INTEGER NOT NULL,
      strikes INTEGER NOT NULL
    );
    -- Razorpay one-time payments (docs/SCALABILITY_ISSUES.md #4). One row per order. "Rails only":
    -- a paid row stamps periodEndsAt but nothing is gated on it yet.
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      planKey TEXT NOT NULL,
      amountPaise INTEGER NOT NULL,
      currency TEXT NOT NULL,
      razorpayOrderId TEXT NOT NULL UNIQUE,
      razorpayPaymentId TEXT,
      status TEXT NOT NULL,
      periodEndsAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payments_userId ON payments(userId, createdAt);
    -- Webhook idempotency: each Razorpay event id is processed at most once (retries are common).
    CREATE TABLE IF NOT EXISTS webhook_events (
      eventId TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL
    );
    -- Per-family parent PIN (PRD-PARENT-AUTH-ALERT-SCOPING §8). Keyed by the
    -- SSO userId — kidgemini has no local accounts table; identity is the JWT.
    CREATE TABLE IF NOT EXISTS parent_auth (
      accountId TEXT PRIMARY KEY,
      pinHash TEXT NOT NULL,
      setAt INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lockedUntil INTEGER,
      lastLockoutAt INTEGER
    );
  `);
  return db;
}

// crypto.randomUUID is available in the Node runtime; avoids Math.random.
function newId(): string {
  return crypto.randomUUID();
}

export class SqliteAlertStore implements AlertStore {
  record(input: Omit<ParentAlert, "id" | "createdAt">): ParentAlert {
    const alert: ParentAlert = { ...input, id: newId(), createdAt: Date.now() };
    getDb()
      .prepare(
        `INSERT INTO alerts (id, createdAt, origin, category, severity, action, triggerText, reason)
         VALUES (@id, @createdAt, @origin, @category, @severity, @action, @triggerText, @reason)`,
      )
      .run(alert);
    return alert;
  }

  list(limit = 100): ParentAlert[] {
    return getDb()
      .prepare(`SELECT * FROM alerts ORDER BY createdAt DESC LIMIT ?`)
      .all(limit) as ParentAlert[];
  }
}

export class SqliteUsageStore implements UsageStore {
  record(input: Omit<UsageEvent, "id" | "createdAt">): UsageEvent {
    const event: UsageEvent = { ...input, id: newId(), createdAt: Date.now() };
    getDb()
      .prepare(
        `INSERT INTO usage_events
         (id, createdAt, userId, userLabel, model, kind, promptTokens, outputTokens,
          costUsd, ip, country, region, city, requestText, outputText, blocked)
         VALUES (@id, @createdAt, @userId, @userLabel, @model, @kind, @promptTokens,
          @outputTokens, @costUsd, @ip, @country, @region, @city, @requestText,
          @outputText, @blocked)`,
      )
      .run({
        ...event,
        ip: event.geo.ip,
        country: event.geo.country,
        region: event.geo.region,
        city: event.geo.city,
        blocked: event.blocked ? 1 : 0,
      });
    return event;
  }

  // Gate tallies exclude kind:'repair' — self-healing repair calls are exempt
  // from the guest/daily budgets by decision (PRD-SELF-HEALING-PREVIEW §12,
  // 2026-07-10): the kid didn't ask for the bug. Repair rows are still
  // recorded, so admin cost dashboards (summarizeSince) see them in full.

  tokensUsedByUser(userId: string, sinceMs = 0): number {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(promptTokens + outputTokens), 0) AS total
         FROM usage_events WHERE userId = ? AND createdAt >= ? AND kind != 'repair'`,
      )
      .get(userId, sinceMs) as { total: number };
    return row.total;
  }

  guestTokensUsedByIp(ip: string, sinceMs = 0): number {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(promptTokens + outputTokens), 0) AS total
         FROM usage_events WHERE ip = ? AND userId LIKE 'guest:%' AND createdAt >= ? AND kind != 'repair'`,
      )
      .get(ip, sinceMs) as { total: number };
    return row.total;
  }

  tokensUsedByUserSince(userId: string, sinceMs: number): number {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(promptTokens + outputTokens), 0) AS total
         FROM usage_events WHERE userId = ? AND createdAt >= ? AND kind != 'repair'`,
      )
      .get(userId, sinceMs) as { total: number };
    return row.total;
  }

  listSince(sinceMs: number): UsageEvent[] {
    const rows = getDb()
      .prepare(`SELECT * FROM usage_events WHERE createdAt >= ? ORDER BY createdAt DESC`)
      .all(sinceMs) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      createdAt: r.createdAt as number,
      userId: r.userId as string,
      userLabel: (r.userLabel as string) ?? null,
      model: r.model as string,
      kind: r.kind as UsageEvent["kind"],
      promptTokens: r.promptTokens as number,
      outputTokens: r.outputTokens as number,
      costUsd: r.costUsd as number,
      geo: {
        ip: (r.ip as string) ?? null,
        country: (r.country as string) ?? null,
        region: (r.region as string) ?? null,
        city: (r.city as string) ?? null,
      },
      requestText: r.requestText as string,
      outputText: r.outputText as string,
      blocked: Boolean(r.blocked),
    }));
  }

  summarizeSince(sinceMs: number): UsageSummary {
    const events = this.listSince(sinceMs);
    const summary: UsageSummary = {
      totalPromptTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      eventCount: events.length,
      byDay: [],
      byUser: [],
      byLocation: [],
    };
    const users = new Map<string, UsageSummary["byUser"][number]>();
    const locs = new Map<string, UsageSummary["byLocation"][number]>();
    // Per-UTC-day rollup + per-day per-user tally (to name each day's top spender).
    const days = new Map<string, UsageSummary["byDay"][number]>();
    const dayUsers = new Map<string, Map<string, { userLabel: string | null; tokens: number }>>();

    for (const e of events) {
      summary.totalPromptTokens += e.promptTokens;
      summary.totalOutputTokens += e.outputTokens;
      summary.totalCostUsd += e.costUsd;

      const u = users.get(e.userId) ?? {
        userId: e.userId,
        userLabel: e.userLabel,
        promptTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        eventCount: 0,
      };
      u.promptTokens += e.promptTokens;
      u.outputTokens += e.outputTokens;
      u.costUsd += e.costUsd;
      u.eventCount += 1;
      users.set(e.userId, u);

      const key = `${e.geo.country}|${e.geo.region}|${e.geo.city}`;
      const l = locs.get(key) ?? {
        country: e.geo.country,
        region: e.geo.region,
        city: e.geo.city,
        eventCount: 0,
        costUsd: 0,
      };
      l.eventCount += 1;
      l.costUsd += e.costUsd;
      locs.set(key, l);

      const day = new Date(e.createdAt).toISOString().slice(0, 10);
      const d = days.get(day) ?? { day, promptTokens: 0, outputTokens: 0, costUsd: 0, eventCount: 0, topUser: null };
      d.promptTokens += e.promptTokens;
      d.outputTokens += e.outputTokens;
      d.costUsd += e.costUsd;
      d.eventCount += 1;
      days.set(day, d);
      const du = dayUsers.get(day) ?? new Map();
      const rec = du.get(e.userId) ?? { userLabel: e.userLabel, tokens: 0 };
      rec.tokens += e.promptTokens + e.outputTokens;
      du.set(e.userId, rec);
      dayUsers.set(day, du);
    }

    for (const d of days.values()) {
      let top: UsageSummary["byDay"][number]["topUser"] = null;
      for (const [userId, rec] of dayUsers.get(d.day) ?? []) {
        if (!top || rec.tokens > top.tokens) top = { userId, userLabel: rec.userLabel, tokens: rec.tokens };
      }
      d.topUser = top;
    }
    summary.byDay = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
    summary.byUser = [...users.values()].sort((a, b) => b.costUsd - a.costUsd);
    summary.byLocation = [...locs.values()].sort((a, b) => b.eventCount - a.eventCount);
    return summary;
  }
}

function mapPaymentRow(r: Record<string, unknown>): PaymentRecord {
  return {
    id: r.id as string,
    userId: r.userId as string,
    planKey: r.planKey as string,
    amountPaise: r.amountPaise as number,
    currency: r.currency as string,
    razorpayOrderId: r.razorpayOrderId as string,
    razorpayPaymentId: (r.razorpayPaymentId as string) ?? null,
    status: r.status as PaymentRecord["status"],
    periodEndsAt: (r.periodEndsAt as number) ?? null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  };
}

export class SqlitePaymentStore implements PaymentStore {
  create(input: {
    userId: string;
    planKey: string;
    amountPaise: number;
    currency: string;
    razorpayOrderId: string;
  }): PaymentRecord {
    const now = Date.now();
    const rec: PaymentRecord = {
      ...input,
      id: newId(),
      razorpayPaymentId: null,
      status: "created",
      periodEndsAt: null,
      createdAt: now,
      updatedAt: now,
    };
    getDb()
      .prepare(
        `INSERT INTO payments
         (id, userId, planKey, amountPaise, currency, razorpayOrderId, razorpayPaymentId,
          status, periodEndsAt, createdAt, updatedAt)
         VALUES (@id, @userId, @planKey, @amountPaise, @currency, @razorpayOrderId,
          @razorpayPaymentId, @status, @periodEndsAt, @createdAt, @updatedAt)`,
      )
      .run(rec);
    return rec;
  }

  markPaid(razorpayOrderId: string, razorpayPaymentId: string, periodEndsAt: number): PaymentRecord | null {
    const info = getDb()
      .prepare(
        `UPDATE payments SET status = 'paid', razorpayPaymentId = ?, periodEndsAt = ?, updatedAt = ?
         WHERE razorpayOrderId = ?`,
      )
      .run(razorpayPaymentId, periodEndsAt, Date.now(), razorpayOrderId);
    if (info.changes === 0) return null;
    return this.getByOrderId(razorpayOrderId);
  }

  isNewEvent(eventId: string): boolean {
    try {
      getDb()
        .prepare(`INSERT INTO webhook_events (eventId, createdAt) VALUES (?, ?)`)
        .run(eventId, Date.now());
      return true;
    } catch {
      return false; // UNIQUE violation ⇒ already processed
    }
  }

  getByOrderId(razorpayOrderId: string): PaymentRecord | null {
    const r = getDb()
      .prepare(`SELECT * FROM payments WHERE razorpayOrderId = ?`)
      .get(razorpayOrderId) as Record<string, unknown> | undefined;
    return r ? mapPaymentRow(r) : null;
  }

  latestForUser(userId: string): PaymentRecord | null {
    const r = getDb()
      .prepare(`SELECT * FROM payments WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`)
      .get(userId) as Record<string, unknown> | undefined;
    return r ? mapPaymentRow(r) : null;
  }
}

export class SqliteParentAuthStore implements ParentAuthStore {
  get(accountId: string): ParentAuthRecord | null {
    const r = getDb().prepare(`SELECT * FROM parent_auth WHERE accountId = ?`).get(accountId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      accountId: r.accountId as string,
      pinHash: r.pinHash as string,
      setAt: r.setAt as number,
      attempts: r.attempts as number,
      lockedUntil: (r.lockedUntil as number | null) ?? null,
      lastLockoutAt: (r.lastLockoutAt as number | null) ?? null,
    };
  }

  put(record: ParentAuthRecord): void {
    getDb()
      .prepare(
        `INSERT INTO parent_auth (accountId, pinHash, setAt, attempts, lockedUntil, lastLockoutAt)
         VALUES (@accountId, @pinHash, @setAt, @attempts, @lockedUntil, @lastLockoutAt)
         ON CONFLICT(accountId) DO UPDATE SET
           pinHash = @pinHash, setAt = @setAt, attempts = @attempts,
           lockedUntil = @lockedUntil, lastLockoutAt = @lastLockoutAt`,
      )
      .run(record);
  }

  recordAttempt(
    accountId: string,
    fields: Pick<ParentAuthRecord, "attempts" | "lockedUntil" | "lastLockoutAt">,
  ): void {
    getDb()
      .prepare(
        `UPDATE parent_auth SET attempts = @attempts, lockedUntil = @lockedUntil,
           lastLockoutAt = @lastLockoutAt WHERE accountId = @accountId`,
      )
      .run({ accountId, ...fields });
  }
}

export class SqliteRateLimitStore implements RateLimitStore {
  hit(ip: string, now: number): RateLimitStatus {
    const db = getDb();
    const prev = (db.prepare(`SELECT * FROM ip_limits WHERE ip = ?`).get(ip) as IpLimitRecord) ?? null;
    const { record, status } = evaluate(prev, ip, now);
    db.prepare(
      `INSERT INTO ip_limits (ip, windowStart, count, blockedUntil, strikes)
       VALUES (@ip, @windowStart, @count, @blockedUntil, @strikes)
       ON CONFLICT(ip) DO UPDATE SET
         windowStart = @windowStart, count = @count, blockedUntil = @blockedUntil, strikes = @strikes`,
    ).run(record);
    return status;
  }
}
