// Parent-alert child scoping (PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2).
// PRIVACY-CRITICAL: a parent must see ONLY their own family's safety alerts,
// never another child's. This is a tenancy boundary — fail closed. Auth/tenancy
// code is NEVER untested (CLAUDE.md §7.4).
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteAlertStore, getDb } from "./db";
import type { ParentAlert } from "@/types/alert.types";

const alert = (accountId: string, triggerText: string): Omit<ParentAlert, "id" | "createdAt"> => ({
  accountId,
  origin: "child",
  category: "profanity",
  severity: "high",
  action: "hard_block",
  triggerText,
  reason: "test",
});

describe("SqliteAlertStore — per-account scoping (parent sees only their own)", () => {
  const store = new SqliteAlertStore();

  it("A.1 list() returns ONLY the queried account's alerts, never another family's", () => {
    store.record(alert("user:mom@a.com", "kid A said a bad word"));
    store.record(alert("user:mom@a.com", "kid A again"));
    store.record(alert("user:dad@b.com", "kid B said something"));

    const familyA = store.list("user:mom@a.com", 100);
    expect(familyA.map((r) => r.triggerText).sort()).toEqual(["kid A again", "kid A said a bad word"]);
    // The other family's alert is NEVER in family A's list.
    expect(familyA.some((r) => r.triggerText.includes("kid B"))).toBe(false);

    const familyB = store.list("user:dad@b.com", 100);
    expect(familyB.map((r) => r.triggerText)).toEqual(["kid B said something"]);
  });

  it("A.2 an unknown account gets an empty list (fail closed)", () => {
    expect(store.list("user:nobody@x.com", 100)).toEqual([]);
  });

  it("A.3 LEGACY alerts (no accountId, pre-migration) are shown to NO ONE", () => {
    // Simulate a pre-scoping row written before the accountId column existed.
    getDb()
      .prepare(
        `INSERT INTO alerts (id, createdAt, accountId, origin, category, severity, action, triggerText, reason)
         VALUES ('legacy-1', 1000, NULL, 'child', 'profanity', 'high', 'hard_block', 'old global alert', 'legacy')`,
      )
      .run();
    // It must not surface for any real account.
    expect(store.list("user:mom@a.com", 100).some((r) => r.id === "legacy-1")).toBe(false);
    expect(store.list("user:dad@b.com", 100).some((r) => r.id === "legacy-1")).toBe(false);
  });

  it("A.4 record round-trips the accountId", () => {
    const rec = store.record(alert("user:solo@x.com", "solo alert"));
    expect(rec.accountId).toBe("user:solo@x.com");
    expect(store.list("user:solo@x.com", 100)[0]!.accountId).toBe("user:solo@x.com");
  });
});
