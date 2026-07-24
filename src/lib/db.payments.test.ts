// Entitlement-boundary test for the pay-any-amount feature (2026-07-24).
//
// A custom (arbitrary-amount) payment must NEVER affect entitlement:
//   1. it grants no access on its own (₹1 can't buy a plan), and
//   2. it must not MASK a real plan the user already holds — `isEntitled` reads
//      only `latestForUser`, so if a newer custom row shadowed the plan row the
//      user would silently lose access.
// Runs against a REAL sqlite file (DATABASE_PATH) because the guard lives in the
// SQL (`latestForUser` excludes CUSTOM_PLAN_KEY) — a mocked store can't prove it.
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
const YEAR_FROM_NOW = Date.now() + 365 * 86_400_000;

function payPlan(orderId: string) {
  store.create({ userId: USER, planKey: "explorer", amountPaise: 120_000, currency: "INR", razorpayOrderId: orderId });
  store.markPaid(orderId, `pay_${orderId}`, YEAR_FROM_NOW);
}
function payCustom(orderId: string, amountPaise = 100) {
  store.create({ userId: USER, planKey: CUSTOM_PLAN_KEY, amountPaise, currency: "INR", razorpayOrderId: orderId });
  store.markPaid(orderId, `pay_${orderId}`, null); // custom → no entitlement period
}

describe("custom pay-any-amount payments and entitlement", () => {
  it("a custom payment alone does NOT entitle the user", () => {
    payCustom("order_custom_only");
    const record = store.latestForUser(USER);
    expect(record).toBeNull(); // custom rows are excluded from the entitlement query
    expect(isEntitled(record)).toBe(false);
  });

  it("a newer custom payment does NOT mask an existing paid plan", () => {
    payPlan("order_plan_1");
    payCustom("order_custom_after_plan"); // created later → would be 'latest' by createdAt
    const record = store.latestForUser(USER);
    expect(record?.planKey).toBe("explorer"); // the plan, not the donation
    expect(isEntitled(record)).toBe(true);
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
