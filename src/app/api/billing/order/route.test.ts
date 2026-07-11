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
});
