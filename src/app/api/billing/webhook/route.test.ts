// Integration: POST /api/billing/webhook. The signature is the only authentication, so the
// security-critical contracts are: invalid signature ⇒ 400 + no write; valid paid event ⇒
// markPaid; duplicate event id ⇒ ignored (idempotent).
//
// 2026-07-27 Phase 5: this is the SOURCE-OF-TRUTH credit path for Sparks
// packs — unlike verify's graceful "pending" degrade, a bridge failure here
// THROWS so Razorpay's own automatic webhook retry keeps trying until the
// ledger accepts the (idempotent, on razorpayPaymentId) credit.

import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyWebhookSignatureMock = vi.fn();
vi.mock("@/lib/razorpay", () => ({
  RazorpayGateway: class {
    verifyWebhookSignature(...args: unknown[]) {
      return verifyWebhookSignatureMock(...args);
    }
  },
}));

const isNewEventMock = vi.fn();
const getByOrderIdMock = vi.fn();
const markPaidMock = vi.fn();
vi.mock("@/lib/db", () => ({
  SqlitePaymentStore: class {
    isNewEvent(...args: unknown[]) {
      return isNewEventMock(...args);
    }
    getByOrderId(...args: unknown[]) {
      return getByOrderIdMock(...args);
    }
    markPaid(...args: unknown[]) {
      return markPaidMock(...args);
    }
  },
}));

const creditPurchaseMock = vi.fn();
vi.mock("@/lib/sparks-bridge", () => ({ creditPurchase: (...args: unknown[]) => creditPurchaseMock(...args) }));

import { POST } from "./route";
import type { NextRequest } from "next/server";

function makeReq(rawBody: string, headers: Record<string, string>): NextRequest {
  return {
    text: async () => rawBody,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const capturedBody = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
});

describe("POST /api/billing/webhook", () => {
  beforeEach(() => {
    verifyWebhookSignatureMock.mockReset();
    isNewEventMock.mockReset();
    getByOrderIdMock.mockReset();
    markPaidMock.mockReset();
    creditPurchaseMock.mockReset();
    markPaidMock.mockReturnValue({});
    creditPurchaseMock.mockResolvedValue({ status: 200, data: { credited: 12_000, balance: 12_000 } });
  });

  it("rejects an invalid signature with 400 and writes nothing", async () => {
    verifyWebhookSignatureMock.mockReturnValue(false);

    const res = await POST(makeReq(capturedBody, { "x-razorpay-signature": "bad" }));

    expect(res.status).toBe(400);
    expect(isNewEventMock).not.toHaveBeenCalled();
    expect(markPaidMock).not.toHaveBeenCalled();
  });

  it("marks the order paid with NO period and credits Sparks via the bridge", async () => {
    verifyWebhookSignatureMock.mockReturnValue(true);
    isNewEventMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ planKey: "pack120", userId: "user:kid@example.com", playerId: "player-1" });

    const res = await POST(
      makeReq(capturedBody, { "x-razorpay-signature": "good", "x-razorpay-event-id": "evt_1" }),
    );

    expect(res.status).toBe(200);
    expect(markPaidMock).toHaveBeenCalledWith("order_1", "pay_1", null);
    expect(creditPurchaseMock).toHaveBeenCalledWith({
      playerId: "player-1",
      packKey: "pack120",
      sparks: 12_000,
      amountInr: 120,
      razorpayPaymentId: "pay_1",
    });
  });

  it("ignores a duplicate event id (idempotent) without marking paid again", async () => {
    verifyWebhookSignatureMock.mockReturnValue(true);
    isNewEventMock.mockReturnValue(false); // already processed

    const res = await POST(
      makeReq(capturedBody, { "x-razorpay-signature": "good", "x-razorpay-event-id": "evt_1" }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("duplicate_ignored");
    expect(markPaidMock).not.toHaveBeenCalled();
  });

  it("a CUSTOM payment marks paid but never calls the Sparks bridge", async () => {
    verifyWebhookSignatureMock.mockReturnValue(true);
    isNewEventMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ planKey: "custom", userId: "user:kid@example.com", playerId: "player-1" });

    const res = await POST(
      makeReq(capturedBody, { "x-razorpay-signature": "good", "x-razorpay-event-id": "evt_2" }),
    );

    expect(res.status).toBe(200);
    expect(creditPurchaseMock).not.toHaveBeenCalled();
  });

  it("THROWS when the Sparks credit fails, so Razorpay retries the webhook", async () => {
    verifyWebhookSignatureMock.mockReturnValue(true);
    isNewEventMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ planKey: "pack200", userId: "user:kid@example.com", playerId: "player-1" });
    creditPurchaseMock.mockResolvedValue({ status: 502, data: { error: "sparks unavailable" } });

    await expect(
      POST(makeReq(capturedBody, { "x-razorpay-signature": "good", "x-razorpay-event-id": "evt_3" })),
    ).rejects.toThrow();
  });
});
