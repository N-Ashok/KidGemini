// Integration: POST /api/billing/webhook. The signature is the only authentication, so the
// security-critical contracts are: invalid signature ⇒ 400 + no write; valid paid event ⇒
// markPaid; duplicate event id ⇒ ignored (idempotent).

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
  });

  it("rejects an invalid signature with 400 and writes nothing", async () => {
    verifyWebhookSignatureMock.mockReturnValue(false);

    const res = await POST(makeReq(capturedBody, { "x-razorpay-signature": "bad" }));

    expect(res.status).toBe(400);
    expect(isNewEventMock).not.toHaveBeenCalled();
    expect(markPaidMock).not.toHaveBeenCalled();
  });

  it("marks the order paid on a valid payment.captured event", async () => {
    verifyWebhookSignatureMock.mockReturnValue(true);
    isNewEventMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ planKey: "monthly", userId: "user:kid@example.com" });

    const res = await POST(
      makeReq(capturedBody, { "x-razorpay-signature": "good", "x-razorpay-event-id": "evt_1" }),
    );

    expect(res.status).toBe(200);
    expect(markPaidMock).toHaveBeenCalledWith("order_1", "pay_1", expect.any(Number));
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
});
