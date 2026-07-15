// Pure entitlement predicate (Phase 5, PRD-MULTIPLAYER.md): extracted from
// api/billing/status/route.ts's inline expression so the new cross-repo
// /api/entitlement/check route can share the exact same rule instead of a
// second, driftable copy.

import { describe, it, expect } from "vitest";
import { isEntitled } from "./entitlement";
import type { PaymentRecord } from "@/types/billing.types";

const NOW = 1_700_000_000_000;

function record(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: "p1",
    userId: "user:kid@example.com",
    planKey: "explorer",
    amountPaise: 120_000,
    currency: "INR",
    razorpayOrderId: "order_1",
    razorpayPaymentId: "pay_1",
    status: "paid",
    periodEndsAt: NOW + 1000,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...overrides,
  };
}

describe("isEntitled", () => {
  it("null record → not entitled", () => {
    expect(isEntitled(null, NOW)).toBe(false);
  });

  it("paid + periodEndsAt in the future → entitled", () => {
    expect(isEntitled(record(), NOW)).toBe(true);
  });

  it("paid but periodEndsAt already passed → not entitled (expired)", () => {
    expect(isEntitled(record({ periodEndsAt: NOW - 1 }), NOW)).toBe(false);
  });

  it("status created (never completed payment) → not entitled even with a future periodEndsAt", () => {
    expect(isEntitled(record({ status: "created", periodEndsAt: NOW + 1000 }), NOW)).toBe(false);
  });

  it("status failed → not entitled", () => {
    expect(isEntitled(record({ status: "failed" }), NOW)).toBe(false);
  });

  it("paid but periodEndsAt is null (shouldn't happen, but fail closed) → not entitled", () => {
    expect(isEntitled(record({ periodEndsAt: null }), NOW)).toBe(false);
  });
});
