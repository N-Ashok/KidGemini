// Integration: POST /api/billing/verify. Pins the fail-closed contract (bad
// signature ⇒ 400, nothing marked paid) and Phase 5 (2026-07-27): a verified
// Sparks-pack payment credits the ledger via the partner bridge; periodEndsAt
// is now always null (packs aren't time-based entitlements — Sparks metering
// replaced the old yearly-access model). A bridge failure still reports the
// payment as paid (it DID succeed) with `pending: true` — the webhook is the
// path that retries the credit to completion.
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

const creditPurchaseMock = vi.fn();
vi.mock("@/lib/sparks-bridge", () => ({ creditPurchase: (...args: unknown[]) => creditPurchaseMock(...args) }));

import { POST } from "./route";
import type { NextRequest } from "next/server";

const USER = "user:kid@example.com";
const PLAYER = "player-1";
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
    creditPurchaseMock.mockReset();
    resolveUserIdMock.mockResolvedValue(USER);
    creditPurchaseMock.mockResolvedValue({ status: 200, data: { credited: 12_000, balance: 12_000 } });
    markPaidMock.mockReturnValue({});
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

  it("a verified PACK payment is marked paid with NO period and credits Sparks via the bridge", async () => {
    verifySigMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ userId: USER, playerId: PLAYER, planKey: "pack120" });
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(200);
    expect(markPaidMock).toHaveBeenCalledWith("order_1", "pay_1", null);
    expect(creditPurchaseMock).toHaveBeenCalledWith({
      playerId: PLAYER,
      packKey: "pack120",
      sparks: 12_000,
      amountInr: 120,
      razorpayPaymentId: "pay_1",
    });
    const json = await res.json();
    expect(json).toMatchObject({ status: "paid", sparksCredited: 12_000, pending: false });
  });

  it("a verified CUSTOM payment is marked paid but credits no Sparks (no bridge call)", async () => {
    verifySigMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ userId: USER, playerId: PLAYER, planKey: "custom" });
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(200);
    expect(markPaidMock).toHaveBeenCalledWith("order_1", "pay_1", null);
    expect(creditPurchaseMock).not.toHaveBeenCalled();
  });

  it("reports paid with pending=true if the Sparks credit fails — payment succeeded, never told otherwise", async () => {
    verifySigMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ userId: USER, playerId: PLAYER, planKey: "pack200" });
    creditPurchaseMock.mockResolvedValue({ status: 502, data: { error: "sparks unavailable" } });
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ status: "paid", sparksCredited: 0, pending: true });
  });

  it("won't let one user confirm another user's order (404)", async () => {
    verifySigMock.mockReturnValue(true);
    getByOrderIdMock.mockReturnValue({ userId: "user:someone-else", playerId: "player-other", planKey: "pack120" });
    const res = await POST(makeReq(GOOD));
    expect(res.status).toBe(404);
    expect(markPaidMock).not.toHaveBeenCalled();
  });
});
