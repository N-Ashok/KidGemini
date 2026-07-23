// SQLite persistence. Single responsibility: store + query alerts and usage events.
// Implements the AlertStore and UsageStore interfaces (Dependency Inversion). Server-only.

import "server-only";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { AlertStore, ParentAlert } from "@/types/alert.types";
import type {
  PeriodTotals,
  RepeatUser,
  UniqueCounts,
  UsageEvent,
  UsageStore,
  UsageSummary,
} from "@/types/usage.types";
import type { IpLimitRecord, RateLimitStatus, RateLimitStore } from "@/types/rate-limit.types";
import type { ParentAuthRecord, ParentAuthStore } from "@/types/parent-auth.types";
import type { ScreenTimeSettings, ScreenTimeDaily, ScreenTimeStore } from "@/types/screen-time.types";
import { utcDayStart, deriveActiveMinutes } from "./screen-time";
import type { PaymentRecord, PaymentStore } from "@/types/billing.types";
import type { ChatHistoryStore, ConvoSummary } from "@/types/chat-history.types";
import type { TurnResult, TurnResultStore } from "@/types/turn-result.types";
import type { Conversation, Workspace } from "@/types/chat.types";
import { evaluate } from "./rate-limit";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
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
      -- Owning account (PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2): the child's
      -- identity when the alert fired. A parent's dashboard query filters by it,
      -- so one family never sees another's. NULL = legacy/un-owned → shown to no one.
      accountId TEXT,
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
      billedPromptTokens INTEGER NOT NULL DEFAULT 0,
      billedOutputTokens INTEGER NOT NULL DEFAULT 0,
      thoughtTokens INTEGER NOT NULL DEFAULT 0,
      cachedTokens INTEGER NOT NULL DEFAULT 0,
      userAgent TEXT,
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
    -- Server-side chat history (TECH_DEBT #26, shipped 2026-07-13): full
    -- conversations (messages JSON incl. generated game HTML) keyed by the
    -- same identity as usage_events (user:<email> or guest:<cookie-uuid>).
    -- localStorage becomes a cache; this is the durable store.
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      messages TEXT NOT NULL,
      -- Which surface owns this thread (PRD-BIBLE-TEACHER): 'default' kid app
      -- vs 'bible-teacher' — the recents list is filtered by it.
      workspace TEXT NOT NULL DEFAULT 'default',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_convos_user ON conversations(userId, updatedAt DESC);
    -- Resumable generations (TECH_DEBT #23, shipped 2026-07-13): each turn's
    -- finished reply keyed by the client's replyId. A disconnected client
    -- (screen lock, stall-guard abort under heavy load) polls
    -- /api/chat/result and collects this instead of re-generating (paid).
    -- 24h TTL, purged on the next start().
    CREATE TABLE IF NOT EXISTS turn_results (
      replyId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT,
      artifactHtml TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turn_results_updated ON turn_results(updatedAt);
    -- (billed* / thought / cached columns migrated below for pre-2026-07-14 DBs)
    -- Per-family parent PIN (PRD-PARENT-AUTH-ALERT-SCOPING §8). Keyed by the
    -- SSO userId — Ari has no local accounts table; identity is the JWT.
    CREATE TABLE IF NOT EXISTS parent_auth (
      accountId TEXT PRIMARY KEY,
      pinHash TEXT NOT NULL,
      setAt INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lockedUntil INTEGER,
      lastLockoutAt INTEGER
    );
    -- Daily screen-time cap (PRD-SCREEN-TIME-CAP-MVP Part B). Keyed by the
    -- same SSO userId as parent_auth — one account per family, no separate
    -- child entity for this feature.
    CREATE TABLE IF NOT EXISTS screen_time_settings (
      accountId TEXT PRIMARY KEY,
      dailyCapMinutes INTEGER,
      updatedAt INTEGER NOT NULL
    );
    -- One row per (account, UTC calendar day). activeMinutes is a cached
    -- tally derived from screen_time_pings timestamps (see screen-time.ts);
    -- alertedAt debounces the cap-crossed alert to once per account per day.
    CREATE TABLE IF NOT EXISTS screen_time_daily (
      accountId TEXT NOT NULL,
      dayStart INTEGER NOT NULL,
      activeMinutes INTEGER NOT NULL DEFAULT 0,
      alertedAt INTEGER,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (accountId, dayStart)
    );
    -- Presence timestamps the daily tally is derived from (2026-07-15): one
    -- row per chat completion AND per client heartbeat tick
    -- (ScreenTimeHeartbeat.tsx, while the tab is open+visible) — the single
    -- source of truth for "how long was this account active," covering both
    -- chatting and playing an already-built game. Pruned to a short window
    -- on write (recordPing) — only "today" is ever queried.
    CREATE TABLE IF NOT EXISTS screen_time_pings (
      accountId TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_screen_time_pings ON screen_time_pings(accountId, createdAt);
  `);
  // Migration (2026-07-14): real billed token counts. Pre-existing DBs lack
  // the columns — add them, then backfill billed=estimate so history keeps
  // counting in the rollups (its cost was estimated from those numbers anyway).
  const usageCols = db.prepare(`PRAGMA table_info(usage_events)`).all() as Array<{ name: string }>;
  if (!usageCols.some((c) => c.name === "billedPromptTokens")) {
    db.exec(`
      ALTER TABLE usage_events ADD COLUMN billedPromptTokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_events ADD COLUMN billedOutputTokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_events ADD COLUMN thoughtTokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE usage_events ADD COLUMN cachedTokens INTEGER NOT NULL DEFAULT 0;
      UPDATE usage_events SET billedPromptTokens = promptTokens, billedOutputTokens = outputTokens;
    `);
  }
  if (!usageCols.some((c) => c.name === "userAgent")) {
    db.exec(`ALTER TABLE usage_events ADD COLUMN userAgent TEXT;`);
  }
  // Workspace column for pre-2026-07-23 DBs (PRD-BIBLE-TEACHER): existing rows
  // default to the kid 'default' surface, so nothing moves out of the main app.
  const convoCols = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
  if (!convoCols.some((c) => c.name === "workspace")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default';`);
  }
  // Per-account alert scoping (PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2). Pre-
  // migration rows get accountId = NULL, so they're shown to NO parent — the
  // safe outcome (an un-owned global alert stops leaking across families).
  const alertCols = db.prepare(`PRAGMA table_info(alerts)`).all() as Array<{ name: string }>;
  if (!alertCols.some((c) => c.name === "accountId")) {
    db.exec(`ALTER TABLE alerts ADD COLUMN accountId TEXT;`);
  }
  // Index built HERE — not in the base CREATE block — because on a pre-existing DB
  // the column is added by the ALTER just above. Indexing alerts(accountId) in the
  // base schema would run BEFORE this migration and throw "no such column: accountId",
  // aborting getDb() and taking parent-PIN/chat-save/alerts down with it (regression
  // fixed 2026-07-23, BUG-FIX-LOG). IF NOT EXISTS is idempotent, so fresh DBs — where
  // the column comes from CREATE TABLE above — get the index here too.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_account ON alerts(accountId, createdAt DESC);`);
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
        `INSERT INTO alerts (id, createdAt, accountId, origin, category, severity, action, triggerText, reason)
         VALUES (@id, @createdAt, @accountId, @origin, @category, @severity, @action, @triggerText, @reason)`,
      )
      .run(alert);
    return alert;
  }

  /** Scoped to one account — a parent NEVER sees another family's alerts
   *  (PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2). A NULL-accountId legacy row
   *  can never match, so it's shown to no one (fail closed). */
  list(accountId: string, limit = 100): ParentAlert[] {
    return getDb()
      .prepare(`SELECT * FROM alerts WHERE accountId = ? ORDER BY createdAt DESC LIMIT ?`)
      .all(accountId, limit) as ParentAlert[];
  }
}

export class SqliteUsageStore implements UsageStore {
  record(input: Omit<UsageEvent, "id" | "createdAt">): UsageEvent {
    const event: UsageEvent = {
      ...input,
      // Real billed counts when the caller has them; otherwise mirror the
      // estimates so every row still lands in the billed rollups.
      billedPromptTokens: input.billedPromptTokens ?? input.promptTokens,
      billedOutputTokens: input.billedOutputTokens ?? input.outputTokens,
      thoughtTokens: input.thoughtTokens ?? 0,
      cachedTokens: input.cachedTokens ?? 0,
      userAgent: input.userAgent ?? null,
      id: newId(),
      createdAt: Date.now(),
    };
    getDb()
      .prepare(
        `INSERT INTO usage_events
         (id, createdAt, userId, userLabel, model, kind, promptTokens, outputTokens,
          billedPromptTokens, billedOutputTokens, thoughtTokens, cachedTokens,
          userAgent, costUsd, ip, country, region, city, requestText, outputText, blocked)
         VALUES (@id, @createdAt, @userId, @userLabel, @model, @kind, @promptTokens,
          @outputTokens, @billedPromptTokens, @billedOutputTokens, @thoughtTokens,
          @cachedTokens, @userAgent, @costUsd, @ip, @country, @region, @city, @requestText,
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

  // Gate tallies exclude kind:'repair' AND kind:'fallback' — neither is spend
  // the child chose. Repair: self-healing fix calls, exempt by decision
  // (PRD-SELF-HEALING-PREVIEW §12, 2026-07-10 — the kid didn't ask for the
  // bug). Fallback: a LOSING model call from a fan-out (owner ask 2026-07-21 —
  // our race/backup waste, not the child's request). Both are still RECORDED
  // so admin cost dashboards (summarizeSince/totalsSince) see them in full.
  private static readonly GATE_EXCLUDED_KINDS = "('repair','fallback')";

  tokensUsedByUser(userId: string, sinceMs = 0): number {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(promptTokens + outputTokens), 0) AS total
         FROM usage_events WHERE userId = ? AND createdAt >= ? AND kind NOT IN ${SqliteUsageStore.GATE_EXCLUDED_KINDS}`,
      )
      .get(userId, sinceMs) as { total: number };
    return row.total;
  }

  guestTokensUsedByIp(ip: string, sinceMs = 0): number {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(promptTokens + outputTokens), 0) AS total
         FROM usage_events WHERE ip = ? AND userId LIKE 'guest:%' AND createdAt >= ? AND kind NOT IN ${SqliteUsageStore.GATE_EXCLUDED_KINDS}`,
      )
      .get(ip, sinceMs) as { total: number };
    return row.total;
  }

  tokensUsedByUserSince(userId: string, sinceMs: number): number {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(promptTokens + outputTokens), 0) AS total
         FROM usage_events WHERE userId = ? AND createdAt >= ? AND kind NOT IN ${SqliteUsageStore.GATE_EXCLUDED_KINDS}`,
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
      billedPromptTokens: (r.billedPromptTokens as number) ?? 0,
      billedOutputTokens: (r.billedOutputTokens as number) ?? 0,
      thoughtTokens: (r.thoughtTokens as number) ?? 0,
      cachedTokens: (r.cachedTokens as number) ?? 0,
      userAgent: (r.userAgent as string) ?? null,
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

  totalsSince(sinceMs: number): PeriodTotals {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS eventCount,
           COALESCE(SUM(billedPromptTokens), 0) AS promptTokens,
           COALESCE(SUM(billedOutputTokens), 0) AS outputTokens,
           COALESCE(SUM(thoughtTokens), 0) AS thoughtTokens,
           COALESCE(SUM(cachedTokens), 0) AS cachedTokens,
           COALESCE(SUM(costUsd), 0) AS costUsd
         FROM usage_events WHERE createdAt >= ?`,
      )
      .get(sinceMs) as PeriodTotals;
    return row;
  }

  uniquesSince(sinceMs: number): UniqueCounts {
    const db = getDb();
    const one = (sql: string) =>
      (db.prepare(sql).get(sinceMs) as { n: number }).n;
    return {
      signedInUsers: one(
        `SELECT COUNT(DISTINCT userId) AS n FROM usage_events
         WHERE createdAt >= ? AND userId LIKE 'user:%'`,
      ),
      guestBrowsers: one(
        `SELECT COUNT(DISTINCT userId) AS n FROM usage_events
         WHERE createdAt >= ? AND userId NOT LIKE 'user:%'`,
      ),
      // Same machine behind a re-minted cookie collapses to one (ip, UA) pair.
      guestDevices: one(
        `SELECT COUNT(DISTINCT COALESCE(ip,'') || '|' || COALESCE(userAgent,'')) AS n
         FROM usage_events WHERE createdAt >= ? AND userId NOT LIKE 'user:%'`,
      ),
    };
  }

  repeatUsersSince(sinceMs: number): RepeatUser[] {
    // '+330 minutes' shifts epoch-ms into IST wall-clock before taking the
    // date — day boundaries match the dashboard's IST rollups, not UTC.
    return getDb()
      .prepare(
        `SELECT userId,
           MAX(userLabel) AS userLabel,
           COUNT(DISTINCT date(createdAt / 1000, 'unixepoch', '+330 minutes')) AS activeDays,
           COUNT(*) AS eventCount,
           MIN(createdAt) AS firstSeen,
           MAX(createdAt) AS lastSeen
         FROM usage_events WHERE createdAt >= ?
         GROUP BY userId
         HAVING activeDays >= 2
         ORDER BY activeDays DESC, lastSeen DESC`,
      )
      .all(sinceMs) as RepeatUser[];
  }

  // Summary token numbers are the BILLED counts (what Google charges for) —
  // the estimate columns exist only to keep the guest/daily gates stable.
  summarizeSince(sinceMs: number): UsageSummary {
    const events = this.listSince(sinceMs);
    const summary: UsageSummary = {
      totalPromptTokens: 0,
      totalOutputTokens: 0,
      totalThoughtTokens: 0,
      totalCachedTokens: 0,
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
      const prompt = e.billedPromptTokens ?? e.promptTokens;
      const output = e.billedOutputTokens ?? e.outputTokens;
      const thoughts = e.thoughtTokens ?? 0;
      const cached = e.cachedTokens ?? 0;
      summary.totalPromptTokens += prompt;
      summary.totalOutputTokens += output;
      summary.totalThoughtTokens += thoughts;
      summary.totalCachedTokens += cached;
      summary.totalCostUsd += e.costUsd;

      const u = users.get(e.userId) ?? {
        userId: e.userId,
        userLabel: e.userLabel,
        promptTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        eventCount: 0,
      };
      u.promptTokens += prompt;
      u.outputTokens += output;
      u.thoughtTokens += thoughts;
      u.cachedTokens += cached;
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
      const d = days.get(day) ?? {
        day, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0,
        costUsd: 0, eventCount: 0, topUser: null,
      };
      d.promptTokens += prompt;
      d.outputTokens += output;
      d.thoughtTokens += thoughts;
      d.cachedTokens += cached;
      d.costUsd += e.costUsd;
      d.eventCount += 1;
      days.set(day, d);
      const du = dayUsers.get(day) ?? new Map();
      const rec = du.get(e.userId) ?? { userLabel: e.userLabel, tokens: 0 };
      rec.tokens += prompt + output;
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

const DAY_MS = 24 * 60 * 60 * 1000;
// Only "today" is ever queried (recomputeAndMaybeAlert), so pings older than
// this are pure dead weight — pruned on every write, same idiom as
// SqliteTurnResultStore.start()'s 24h sweep.
const PING_RETENTION_MS = 2 * DAY_MS;

/** Daily screen-time cap + alert (PRD-SCREEN-TIME-CAP-MVP Part B). Minutes
 *  are derived from screen_time_pings on every recompute — one row per chat
 *  completion AND per client heartbeat tick (ScreenTimeHeartbeat.tsx), so
 *  playing an already-built game counts the same as chatting. DI'd with an
 *  AlertStore so "fires exactly once" is testable without a second store
 *  reaching into the same DB. */
export class SqliteScreenTimeStore implements ScreenTimeStore {
  constructor(private alerts: AlertStore = new SqliteAlertStore()) {}

  recordPing(accountId: string, nowMs: number): void {
    const db = getDb();
    db.prepare(`DELETE FROM screen_time_pings WHERE createdAt < ?`).run(nowMs - PING_RETENTION_MS);
    db.prepare(`INSERT INTO screen_time_pings (accountId, createdAt) VALUES (?, ?)`).run(accountId, nowMs);
  }

  getSettings(accountId: string): ScreenTimeSettings | null {
    const r = getDb().prepare(`SELECT * FROM screen_time_settings WHERE accountId = ?`).get(accountId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      accountId: r.accountId as string,
      dailyCapMinutes: (r.dailyCapMinutes as number | null) ?? null,
      updatedAt: r.updatedAt as number,
    };
  }

  putSettings(accountId: string, dailyCapMinutes: number | null): ScreenTimeSettings {
    const updatedAt = Date.now();
    getDb()
      .prepare(
        `INSERT INTO screen_time_settings (accountId, dailyCapMinutes, updatedAt)
         VALUES (@accountId, @dailyCapMinutes, @updatedAt)
         ON CONFLICT(accountId) DO UPDATE SET
           dailyCapMinutes = @dailyCapMinutes, updatedAt = @updatedAt`,
      )
      .run({ accountId, dailyCapMinutes, updatedAt });
    return { accountId, dailyCapMinutes, updatedAt };
  }

  getToday(accountId: string, dayStart: number): ScreenTimeDaily | null {
    const r = getDb()
      .prepare(`SELECT * FROM screen_time_daily WHERE accountId = ? AND dayStart = ?`)
      .get(accountId, dayStart) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      accountId: r.accountId as string,
      dayStart: r.dayStart as number,
      activeMinutes: r.activeMinutes as number,
      alertedAt: (r.alertedAt as number | null) ?? null,
      updatedAt: r.updatedAt as number,
    };
  }

  recomputeAndMaybeAlert(accountId: string, userLabel: string | null, nowMs: number): void {
    const dayStart = utcDayStart(nowMs);
    const rows = getDb()
      .prepare(
        `SELECT createdAt FROM screen_time_pings
         WHERE accountId = ? AND createdAt >= ? AND createdAt < ?
         ORDER BY createdAt ASC`,
      )
      .all(accountId, dayStart, dayStart + DAY_MS) as Array<{ createdAt: number }>;
    const activeMinutes = deriveActiveMinutes(rows.map((r) => r.createdAt));

    const existing = this.getToday(accountId, dayStart);
    const cap = this.getSettings(accountId)?.dailyCapMinutes ?? null;
    const alreadyAlerted = existing?.alertedAt != null;
    const shouldAlert = !alreadyAlerted && cap !== null && activeMinutes >= cap;
    const alertedAt = shouldAlert ? nowMs : (existing?.alertedAt ?? null);

    getDb()
      .prepare(
        `INSERT INTO screen_time_daily (accountId, dayStart, activeMinutes, alertedAt, updatedAt)
         VALUES (@accountId, @dayStart, @activeMinutes, @alertedAt, @updatedAt)
         ON CONFLICT(accountId, dayStart) DO UPDATE SET
           activeMinutes = @activeMinutes, alertedAt = @alertedAt, updatedAt = @updatedAt`,
      )
      .run({ accountId, dayStart, activeMinutes, alertedAt, updatedAt: nowMs });

    if (shouldAlert) {
      this.alerts.record({
        accountId, // scope the screen-time alert to this family (PRD-PARENT-AUTH §8 Phase 2)
        origin: "system",
        category: null,
        severity: "low",
        action: "allow",
        triggerText: "Daily screen-time cap reached",
        reason: `${userLabel ?? "Your child"} has used Ari for ${activeMinutes} min today — your cap is ${cap} min.`,
      });
    }
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

/** Server-side chat history (TECH_DEBT #26). Ownership is fail-closed at the
 *  SQL layer: reads filter by userId, and an upsert only updates a row whose
 *  userId matches — a colliding id from another identity is silently ignored. */
export class SqliteChatHistoryStore implements ChatHistoryStore {
  upsert(userId: string, convo: Conversation, now: number): void {
    getDb()
      .prepare(
        // workspace is set on INSERT and left untouched on UPDATE — a thread's
        // surface is fixed at creation (a bible-teacher chat can't migrate into
        // the kid app by being re-saved).
        `INSERT INTO conversations (id, userId, title, messages, workspace, createdAt, updatedAt)
         VALUES (@id, @userId, @title, @messages, @workspace, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, messages = excluded.messages, updatedAt = excluded.updatedAt
         WHERE conversations.userId = excluded.userId`,
      )
      .run({ id: convo.id, userId, title: convo.title, messages: JSON.stringify(convo.messages), workspace: convo.workspace ?? "default", now });
  }

  bulkUpsert(userId: string, convos: Conversation[], now: number): number {
    // Stamp in list order so the FIRST convo (newest in the client's
    // newest-first list) gets the freshest updatedAt and keeps its rank.
    let n = 0;
    for (const c of convos) {
      this.upsert(userId, c, now - n);
      n += 1;
    }
    return n;
  }

  list(userId: string, limit: number, before?: { updatedAt: number; id: string }, workspace: Workspace = "default"): ConvoSummary[] {
    const rows = (
      before === undefined
        ? getDb()
            .prepare(`SELECT id, title, updatedAt FROM conversations WHERE userId = ? AND workspace = ? ORDER BY updatedAt DESC, id LIMIT ?`)
            .all(userId, workspace, limit)
        : getDb()
            .prepare(
              // Composite cursor: strictly older, OR same-ms rows after the
              // prior page's last id (ORDER BY ... id ASC ties the order).
              `SELECT id, title, updatedAt FROM conversations
               WHERE userId = @userId AND workspace = @workspace AND (updatedAt < @u OR (updatedAt = @u AND id > @i))
               ORDER BY updatedAt DESC, id LIMIT @limit`,
            )
            .all({ userId, workspace, u: before.updatedAt, i: before.id, limit })
    ) as ConvoSummary[];
    return rows;
  }

  get(userId: string, id: string): Conversation | null {
    const row = getDb()
      .prepare(`SELECT id, title, messages, workspace FROM conversations WHERE id = ? AND userId = ?`)
      .get(id, userId) as { id: string; title: string; messages: string; workspace?: string } | undefined;
    if (!row) return null;
    try {
      return { id: row.id, title: row.title, messages: JSON.parse(row.messages), ...(row.workspace && row.workspace !== "default" ? { workspace: row.workspace as Workspace } : {}) };
    } catch {
      return null; // corrupt row — treat as missing, never throw into a route
    }
  }

  claim(fromUserId: string, toUserId: string): number {
    if (fromUserId === toUserId) return 0;
    const result = getDb()
      .prepare(
        `UPDATE conversations SET userId = @toUserId
         WHERE userId = @fromUserId
           AND id NOT IN (SELECT id FROM conversations WHERE userId = @toUserId)`,
      )
      .run({ fromUserId, toUserId });
    return result.changes;
  }
}

/** Resumable generations (TECH_DEBT #23): each turn's finished reply, keyed
 *  by the client-generated replyId, so a disconnected client (screen lock,
 *  stall-guard abort under heavy load) collects the finished result instead
 *  of paying for a re-generation. Rows expire after 24h (purged on start).
 *  Ownership fail-closed: reads and writes are keyed by (replyId, userId). */
export class SqliteTurnResultStore implements TurnResultStore {
  start(replyId: string, userId: string, now: number): void {
    const db = getDb();
    db.prepare(`DELETE FROM turn_results WHERE updatedAt < ?`).run(now - 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO turn_results (replyId, userId, status, text, artifactHtml, createdAt, updatedAt)
       VALUES (@replyId, @userId, 'running', NULL, NULL, @now, @now)
       ON CONFLICT(replyId) DO UPDATE SET status = 'running', text = NULL, artifactHtml = NULL, updatedAt = @now
       WHERE turn_results.userId = @userId`,
    ).run({ replyId, userId, now });
  }

  complete(replyId: string, userId: string, text: string, artifactHtml: string | null, now: number): void {
    getDb()
      .prepare(
        `UPDATE turn_results SET status = 'done', text = @text, artifactHtml = @artifactHtml, updatedAt = @now
         WHERE replyId = @replyId AND userId = @userId`,
      )
      .run({ replyId, userId, text, artifactHtml, now });
  }

  fail(replyId: string, userId: string, now: number): void {
    getDb()
      .prepare(
        `UPDATE turn_results SET status = 'error', updatedAt = @now
         WHERE replyId = @replyId AND userId = @userId`,
      )
      .run({ replyId, userId, now });
  }

  get(userId: string, replyId: string): TurnResult | null {
    const row = getDb()
      .prepare(`SELECT status, text, artifactHtml FROM turn_results WHERE replyId = ? AND userId = ?`)
      .get(replyId, userId) as { status: TurnResult["status"]; text: string | null; artifactHtml: string | null } | undefined;
    if (!row) return null;
    return { status: row.status, text: row.text ?? undefined, artifactHtml: row.artifactHtml };
  }
}
