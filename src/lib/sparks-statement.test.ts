import { describe, it, expect } from "vitest";
import { summarizeSinceLastRecharge, type StatementTxn } from "./sparks-statement";

// Owner report 2026-08-09: "nothing provided the details of total sparks used
// in the sparks management from the last recharge. ledger is not clear." The
// parent card listed every transaction but never answered the one question a
// person who paid actually asks: how much of what I put in is gone?
//
// "Recharge" is defined as the most recent CREDIT (any positive amount) rather
// than a hardcoded list of kinds — production has 0 `purchase` rows so far and
// every balance to date arrived as `admin_grant`, so a purchase-only rule would
// summarise nothing for every current user.

const txn = (over: Partial<StatementTxn> & { at: string; amount: number }): StatementTxn => ({
  id: `t-${over.at}`,
  kind: over.amount > 0 ? "admin_grant" : "usage_debit",
  balanceAfter: 0,
  meta: {},
  ...over,
});

describe("sparks spent since the last recharge", () => {
  it("sums only the debits AFTER the newest credit", () => {
    const s = summarizeSinceLastRecharge([
      txn({ at: "2026-08-05T10:00:00Z", amount: -300 }), // before the recharge — excluded
      txn({ at: "2026-08-06T10:00:00Z", amount: 100_000, kind: "admin_grant" }),
      txn({ at: "2026-08-07T10:00:00Z", amount: -1_200 }),
      txn({ at: "2026-08-08T10:00:00Z", amount: -800 }),
    ]);
    expect(s).not.toBeNull();
    expect(s!.spent).toBe(2_000);
    expect(s!.added).toBe(100_000);
    expect(s!.builds).toBe(2);
    expect(s!.kind).toBe("admin_grant");
  });

  it("is order-independent — the ledger may arrive newest-first or oldest-first", () => {
    const rows = [
      txn({ at: "2026-08-06T10:00:00Z", amount: 100_000 }),
      txn({ at: "2026-08-07T10:00:00Z", amount: -1_200 }),
    ];
    expect(summarizeSinceLastRecharge(rows)!.spent).toBe(1_200);
    expect(summarizeSinceLastRecharge([...rows].reverse())!.spent).toBe(1_200);
  });

  it("reports zero spent immediately after a recharge (not a missing summary)", () => {
    const s = summarizeSinceLastRecharge([txn({ at: "2026-08-06T10:00:00Z", amount: 50_000 })]);
    expect(s!.spent).toBe(0);
    expect(s!.builds).toBe(0);
  });

  it("counts only usage debits as builds, not revocations", () => {
    const s = summarizeSinceLastRecharge([
      txn({ at: "2026-08-06T10:00:00Z", amount: 12_000 }),
      txn({ at: "2026-08-07T10:00:00Z", amount: -500, kind: "usage_debit" }),
      txn({ at: "2026-08-08T10:00:00Z", amount: -200, kind: "admin_revoke" }),
    ]);
    expect(s!.spent).toBe(700); // both leave the balance
    expect(s!.builds).toBe(1); // but only one was a build
  });

  it("uses the NEWEST credit when several recharges exist", () => {
    const s = summarizeSinceLastRecharge([
      txn({ at: "2026-08-01T10:00:00Z", amount: 12_000 }),
      txn({ at: "2026-08-02T10:00:00Z", amount: -5_000 }),
      txn({ at: "2026-08-03T10:00:00Z", amount: 50_000, kind: "purchase" }),
      txn({ at: "2026-08-04T10:00:00Z", amount: -900 }),
    ]);
    expect(s!.spent).toBe(900);
    expect(s!.kind).toBe("purchase");
  });

  it("returns null when there is no ledger at all", () => {
    expect(summarizeSinceLastRecharge([])).toBeNull();
  });

  it("falls back to the whole history when the account has only ever spent", () => {
    // No credit row at all (e.g. a grant that predates the statement window).
    // Showing nothing here would be the same silence the owner reported, so we
    // summarise what we DO have and say so via `sinceStart`.
    const s = summarizeSinceLastRecharge([
      txn({ at: "2026-08-07T10:00:00Z", amount: -1_200 }),
      txn({ at: "2026-08-08T10:00:00Z", amount: -800 }),
    ]);
    expect(s).not.toBeNull();
    expect(s!.sinceStart).toBe(true);
    expect(s!.spent).toBe(2_000);
    expect(s!.added).toBe(0);
  });

  it("ignores rows with an unparseable date rather than throwing", () => {
    const s = summarizeSinceLastRecharge([
      txn({ at: "not-a-date", amount: -999 }),
      txn({ at: "2026-08-06T10:00:00Z", amount: 10_000 }),
      txn({ at: "2026-08-07T10:00:00Z", amount: -400 }),
    ]);
    expect(s!.spent).toBe(400);
  });
});
