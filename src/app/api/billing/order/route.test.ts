// Integration: POST /api/billing/order. Pins the fail-closed contract (401 when not signed in,
// Razorpay never called) and the happy path (creates an order + records it).

import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveUserIdMock = vi.fn();
vi.mock("@/lib/auth-identity", () => ({ resolveUserId: () => resolveUserIdMock() }));

const createOrderMock = vi.fn();
vi.mock("@/lib/razorpay", () => ({
  RazorpayGateway: class {
    get keyId() {
      return "rzp_test_123";
    }
    createOrder(...args: unknown[]) {
      return createOrderMock(...args);
    }
  },
}));

const createPaymentMock = vi.fn();
vi.mock("@/lib/db", () => ({
  SqlitePaymentStore: class {
    create(...args: unknown[]) {
      return createPaymentMock(...args);
    }
  },
}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/billing/order", () => {
  beforeEach(() => {
    resolveUserIdMock.mockReset();
    createOrderMock.mockReset();
    createPaymentMock.mockReset();
  });

  it("returns 401 and never calls Razorpay when unauthenticated", async () => {
    resolveUserIdMock.mockResolvedValue(null);

    const res = await POST(makeReq({ planKey: "explorer" }));

    expect(res.status).toBe(401);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown plan with 400", async () => {
    resolveUserIdMock.mockResolvedValue("user:kid@example.com");

    const res = await POST(makeReq({ planKey: "nope" }));

    expect(res.status).toBe(400);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("creates an order and records it for an authenticated user", async () => {
    resolveUserIdMock.mockResolvedValue("user:kid@example.com");
    createOrderMock.mockResolvedValue({ id: "order_abc", amount: 69_900, currency: "INR" });

    const res = await POST(makeReq({ planKey: "explorer" }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ orderId: "order_abc", amount: 69_900, currency: "INR", keyId: "rzp_test_123" });
    expect(createOrderMock).toHaveBeenCalledTimes(1);
    expect(createPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user:kid@example.com", planKey: "explorer", razorpayOrderId: "order_abc" }),
    );
  });

  // ── Pay-any-amount (2026-07-24) ──────────────────────────────────────────
  it("creates a custom-amount order and records it under the custom sentinel", async () => {
    resolveUserIdMock.mockResolvedValue("user:kid@example.com");
    createOrderMock.mockResolvedValue({ id: "order_custom", amount: 50_000, currency: "INR" });

    const res = await POST(makeReq({ amountPaise: 50_000 })); // ₹500

    expect(res.status).toBe(200);
    expect(createOrderMock).toHaveBeenCalledWith(expect.objectContaining({ amountPaise: 50_000 }));
    expect(createPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ planKey: "custom", amountPaise: 50_000, razorpayOrderId: "order_custom" }),
    );
  });

  it("rejects a below-floor custom amount with 400 and never calls Razorpay", async () => {
    resolveUserIdMock.mockResolvedValue("user:kid@example.com");
    const res = await POST(makeReq({ amountPaise: 99 })); // < ₹1
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_amount" });
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("rejects an above-cap custom amount with 400", async () => {
    resolveUserIdMock.mockResolvedValue("user:kid@example.com");
    const res = await POST(makeReq({ amountPaise: 10_000_001 })); // > ₹1,00,000
    expect(res.status).toBe(400);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("rejects a negative / non-integer custom amount with 400 (fail-closed)", async () => {
    resolveUserIdMock.mockResolvedValue("user:kid@example.com");
    expect((await POST(makeReq({ amountPaise: -500 }))).status).toBe(400);
    expect((await POST(makeReq({ amountPaise: 100.5 }))).status).toBe(400);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("still requires auth for a custom amount (401, no Razorpay)", async () => {
    resolveUserIdMock.mockResolvedValue(null);
    const res = await POST(makeReq({ amountPaise: 50_000 }));
    expect(res.status).toBe(401);
    expect(createOrderMock).not.toHaveBeenCalled();
  });
});
