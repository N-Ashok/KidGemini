// Entitlement-boundary test for the pay-any-amount feature (2026-07-24),
// updated 2026-07-27 for Phase 5 Sparks packs: NO plan key grants a
// time-based period anymore (Sparks are metered, not periodDays access —
// see verify/route.ts's comment), so `isEntitled` is now always false. That
// makes the platform-side `entitlement-service.ts` check permanently false
// too — harmless today because it's RELAXED by default and never enforced
// (see Ariantra-Platform TECH_DEBT.md), but worth pinning here so a future
// re-enable of that flag doesn't get a silent "always false" surprise.
//
// What THIS test still protects: `latestForUser`'s SQL guard that a custom
// (arbitrary-amount) payment must not MASK a real pack purchase the user
// already made — if a newer custom row shadowed the pack row, any future
// entitlement model built on `latestForUser` would silently misread it.
// Runs against a REAL sqlite file (DATABASE_PATH) because the guard lives in
// the SQL (`latestForUser` excludes CUSTOM_PLAN_KEY) — a mocked store can't
// prove it.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "kg-pay-"));
process.env.DATABASE_PATH = join(dir, "test.db");

const { SqlitePaymentStore } = await import("./db");
const { isEntitled } = await import("./entitlement");
const { CUSTOM_PLAN_KEY } = await import("./billing.config");

const store = new SqlitePaymentStore();
const USER = "user:kid@example.com";
const PLAYER = "player-1";

function payPack(orderId: string) {
  store.create({ userId: USER, playerId: PLAYER, planKey: "pack120", amountPaise: 12_000, currency: "INR", razorpayOrderId: orderId });
  store.markPaid(orderId, `pay_${orderId}`, null); // packs grant Sparks, never a time period
}
function payCustom(orderId: string, amountPaise = 100) {
  store.create({ userId: USER, playerId: PLAYER, planKey: CUSTOM_PLAN_KEY, amountPaise, currency: "INR", razorpayOrderId: orderId });
  store.markPaid(orderId, `pay_${orderId}`, null); // custom → no entitlement period
}

describe("custom pay-any-amount payments and entitlement (Phase 5)", () => {
  it("a custom payment alone does NOT entitle the user", () => {
    payCustom("order_custom_only");
    const record = store.latestForUser(USER);
    expect(record).toBeNull(); // custom rows are excluded from the entitlement query
    expect(isEntitled(record)).toBe(false);
  });

  it("a newer custom payment does NOT mask an existing pack purchase", () => {
    payPack("order_pack_1");
    payCustom("order_custom_after_pack"); // created later → would be 'latest' by createdAt
    const record = store.latestForUser(USER);
    expect(record?.planKey).toBe("pack120"); // the pack, not the donation
    // No plan key grants a time period anymore — a real purchase is STILL
    // not "entitled" in the old sense. This is expected, not a regression:
    // Sparks metering is the real gate now (SparksService.canStart).
    expect(isEntitled(record)).toBe(false);
  });

  it("the custom row is still persisted (recorded as paid) for reconciliation", () => {
    payCustom("order_custom_persist", 250_00);
    const row = store.getByOrderId("order_custom_persist");
    expect(row?.status).toBe("paid");
    expect(row?.planKey).toBe(CUSTOM_PLAN_KEY);
    expect(row?.periodEndsAt).toBeNull();
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
