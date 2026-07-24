// Integration: POST /api/billing/verify. Pins the fail-closed contract (bad
// signature ⇒ 400, nothing marked paid) and the pay-any-amount rule added
// 2026-07-24: a custom charge is marked paid but stamped with NO access period,
// while a real plan gets its entitlement window.
import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveUserIdMock = vi.fn();
vi.mock("@/lib/auth-identity", () => ({ resolveUserId: () => resolveUserIdMock() }));

const verifySigMock = vi.fn();
vi.mock("@/lib/razorpay", () => ({
  RazorpayGateway: class {
    verifyPaymentSignature(...args: unknown[]) {
      return verifySigMock(...args);
    }
  },
}));

const getByOrderIdMock = vi.fn();
const markPaidMock = vi.fn();
vi.mock("@/lib/db", () => ({
  SqlitePaymentStore: class {
    getByOrderId(...args: unknown[]) {
      return getByOrderIdMock(...args);
    }
    markPaid(...args: unknown[]) {
      return markPaidMock(...args);
    }
  },
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

const USER = "user:kid@example.com";
const GOOD = { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "sig" };

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/billing/verify", () => {
  beforeEach(() => {
    resolveUserIdMock.mockReset();
    verifySigMock.mockReset();
    getByOrderIdMock.mockReset();
    markPaidMock.mockReset();
    resolveUserIdMock.mockResolvedValue(USER);
  });

  it("rejects a bad signature with 400 and marks nothing paid", async () => {
    verifySigMock.mockReturnValue(false);
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(400);
    expect(markPaidMock).not.toHaveBeenCalled();
  });

  it("401 when unauthenticated, signature never checked", async () => {
    resolveUserIdMock.mockResolvedValue(null);
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(401);
    expect(verifySigMock).not.toHaveBeenCalled();
  });

  it("400 on missing fields", async () => {
    const res = await POST(makeReq({ razorpay_order_id: "order_1" }));
    expect(res.status).toBe(400);
    expect(markPaidMock).not.toHaveBeenCalled();
  });

  it("a verified PLAN payment is marked paid with a future access period", async () => {
    verifySigMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ userId: USER, planKey: "explorer" });
    markPaidMock.mockReturnValue({});
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(200);
    expect(markPaidMock).toHaveBeenCalledTimes(1);
    const periodEndsAt = markPaidMock.mock.calls[0]![2] as number;
    expect(typeof periodEndsAt).toBe("number");
    expect(periodEndsAt).toBeGreaterThan(Date.now());
  });

  it("a verified CUSTOM payment is marked paid but with NO period (grants nothing)", async () => {
    verifySigMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ userId: USER, planKey: "custom" });
    markPaidMock.mockReturnValue({});
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(200);
    expect(markPaidMock).toHaveBeenCalledWith("order_1", "pay_1", null);
  });

  it("won't let one user confirm another user's order (404)", async () => {
    verifySigMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ userId: "user:someone-else", planKey: "explorer" });
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(404);
    expect(markPaidMock).not.toHaveBeenCalled();
  });
});
