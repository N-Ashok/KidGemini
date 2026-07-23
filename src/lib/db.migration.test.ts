// Regression (BUG-FIX-LOG 2026-07-23): an EXISTING DB whose `alerts` table
// predates the accountId column must migrate cleanly. The first cut of the
// per-account-scoping change created an index on alerts(accountId) in the BASE
// schema block — which runs BEFORE the migration that adds the column. On any
// pre-existing DB, `CREATE TABLE IF NOT EXISTS` is a no-op, so that index build
// threw "no such column: accountId" and aborted getDb() entirely — silently
// breaking parent-PIN verification, chat-save, and alerts all at once.
//
// The unit tests that shipped with the feature all used :memory: (a FRESH DB,
// where the column exists from CREATE TABLE), so they never hit this path. This
// test seeds the OLD schema on a real file, exactly like production.
import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

describe("db migration — a pre-accountId DB upgrades without aborting getDb()", () => {
  let dir = "";
  const prevPath = process.env.DATABASE_PATH;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.env.DATABASE_PATH = prevPath;
    vi.resetModules();
  });

  it("M.1 opens a legacy alerts DB (no accountId column) and can record + list", async () => {
    dir = mkdtempSync(join(tmpdir(), "kg-db-mig-"));
    const path = join(dir, "legacy.db");

    // Seed the OLD alerts schema — WITHOUT accountId — exactly like production.
    const seed = new Database(path);
    seed.exec(`
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL,
        origin TEXT NOT NULL,
        category TEXT,
        severity TEXT NOT NULL,
        action TEXT NOT NULL,
        triggerText TEXT NOT NULL,
        reason TEXT NOT NULL
      );
    `);
    seed
      .prepare(
        `INSERT INTO alerts (id, createdAt, origin, category, severity, action, triggerText, reason)
         VALUES ('old-1', 1, 'child', 'profanity', 'high', 'hard_block', 'legacy row', 'pre-migration')`,
      )
      .run();
    seed.close();

    process.env.DATABASE_PATH = path;
    vi.resetModules();
    const { SqliteAlertStore, getDb } = await import("./db");

    // The regression: getDb() threw "no such column: accountId" and never returned.
    expect(() => getDb()).not.toThrow();

    // The migration added the column (and its index) instead of crashing.
    const cols = getDb().prepare(`PRAGMA table_info(alerts)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "accountId")).toBe(true);

    // New scoped writes/reads work on the upgraded DB.
    const store = new SqliteAlertStore();
    store.record({
      accountId: "user:mom@a.com",
      origin: "child",
      category: "profanity",
      severity: "high",
      action: "hard_block",
      triggerText: "new alert",
      reason: "t",
    });
    expect(store.list("user:mom@a.com", 100).map((r) => r.triggerText)).toContain("new alert");

    // The pre-migration legacy row (accountId NULL) is shown to no one — fail closed.
    expect(store.list("user:mom@a.com", 100).some((r) => r.id === "old-1")).toBe(false);
  });
});
