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
      byUser: [],
      byLocation: [],
    };
    const users = new Map<string, UsageSummary["byUser"][number]>();
    const locs = new Map<string, UsageSummary["byLocation"][number]>();

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
    }

    summary.byUser = [...users.values()].sort((a, b) => b.costUsd - a.costUsd);
    summary.byLocation = [...locs.values()].sort((a, b) => b.eventCount - a.eventCount);
    return summary;
  }
}
