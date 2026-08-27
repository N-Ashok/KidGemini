/** Sparks bridge — contract + fail-safety. The platform owns the ledger;
 *  these tests pin what Ari SENDS and that failures never propagate. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { billSparks, fetchGate, fetchWallet, redeemCoupon, submitSocialShare, creditPurchase } from "./sparks-bridge";

const okJson = (data: unknown) =>
  Promise.resolve({ status: 200, json: () => Promise.resolve(data) } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.AUTH_JWT_SECRET = "test-secret";
  fetchMock = vi.fn(() => okJson({ charged: 42, gauge: "good" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("billSparks", () => {
  it("POSTs the debit with secret header, session token, and a stable turnId", async () => {
    billSparks({
      sessionToken: "jwt-abc",
      replyId: "reply-9",
      seq: 0,
      kind: "chat",
      usage: { model: "gemini-3-flash-preview", tokensIn: 4000, tokensOut: 12000, costUsd: 0.038 },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/studio/partner/sparks");
    expect((init.headers as Record<string, string>)["x-admin-secret"]).toBe("test-secret");
    const body = JSON.parse(init.body as string);
    expect(body.sessionToken).toBe("jwt-abc");
    expect(body.debit.turnId).toBe("reply-9:chat:gemini-3-flash-preview:0");
    expect(body.debit.usage[0].costUsd).toBe(0.038);
  });

  it("never throws when the network is down (billing must not break a turn)", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    expect(() =>
      billSparks({ sessionToken: "t", replyId: "r", seq: 1, kind: "fallback", usage: { model: "m", tokensIn: 1, tokensOut: 1 } }),
    ).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  // docs/PRD-SPARKS.md 3D pricing amendment (platform repo): the platform
  // bills at the 3D rate ONLY when it sees the literal boolean `is3D: true`
  // in the debit payload — so a 3D turn must send it, and a 2D turn must omit
  // it (not send `false`), matching the platform's fail-closed parsing.
  it("is3D:true is included in the debit payload for a 3D turn", async () => {
    billSparks({
      sessionToken: "jwt-3d",
      replyId: "reply-3d",
      seq: 0,
      kind: "chat",
      is3D: true,
      usage: { model: "gemini-3-flash-preview", tokensIn: 4000, tokensOut: 12000 },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.debit.is3D).toBe(true);
  });

  it("omits is3D entirely for an ordinary 2D turn", async () => {
    billSparks({
      sessionToken: "jwt-2d",
      replyId: "reply-2d",
      seq: 0,
      kind: "chat",
      usage: { model: "gemini-3-flash-preview", tokensIn: 4000, tokensOut: 12000 },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.debit).not.toHaveProperty("is3D");
  });
});

describe("reads and parent actions", () => {
  it("fetchWallet / redeemCoupon / submitSocialShare pass through platform responses", async () => {
    fetchMock.mockImplementation(() => okJson({ gauge: "low", earnedTotal: 3000 }));
    const w = await fetchWallet("jwt");
    expect(w.status).toBe(200);
    expect(w.data.gauge).toBe("low");

    fetchMock.mockImplementation(() => okJson({ credited: 400 }));
    expect((await redeemCoupon("jwt", "CODE")).data.credited).toBe(400);

    fetchMock.mockImplementation(() => okJson({ credited: 300 }));
    const s = await submitSocialShare("jwt", "shark-racer", "twitter", "https://x.com/x/1");
    expect(s.data.credited).toBe(300);
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
    expect(body.socialShare.platform).toBe("twitter");
  });

  it("network failure surfaces as a 502 result, not a throw", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("timeout")));
    const w = await fetchWallet("jwt");
    expect(w.status).toBe(502);
  });

  // 2026-08-07 exhaustion gate: the cheap pre-turn check (canStart) + the
  // once-only trial flag (trialUsed) — chat refuses a new turn and the order
  // route refuses a repeat trial purchase off this one call.
  it("fetchGate sends { sessionToken, gate: true } and passes canStart/trialUsed through", async () => {
    fetchMock.mockImplementation(() => okJson({ canStart: false, trialUsed: true }));
    const g = await fetchGate("jwt");
    expect(g.status).toBe(200);
    expect(g.data.canStart).toBe(false);
    expect(g.data.trialUsed).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
    expect(body.gate).toBe(true);
    expect(body.sessionToken).toBe("jwt");
  });
});

describe("creditPurchase — Phase 5 Sparks pack top-up (server-to-server, no sessionToken)", () => {
  it("POSTs the purchase with playerId, pack details, and razorpayPaymentId as the idempotency key", async () => {
    fetchMock.mockImplementation(() => okJson({ credited: 12_000, balance: 12_000 }));
    const r = await creditPurchase({
      playerId: "player-1",
      packKey: "pack120",
      sparks: 12_000,
      amountInr: 120,
      razorpayPaymentId: "pay_abc",
    });
    expect(r.status).toBe(200);
    expect(r.data.credited).toBe(12_000);
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
    expect(body.sessionToken).toBeUndefined();
    expect(body.purchase).toEqual({
      playerId: "player-1",
      packKey: "pack120",
      sparks: 12_000,
      amountInr: 120,
      razorpayPaymentId: "pay_abc",
    });
  });

  it("network failure surfaces as a 502 result — the caller decides whether that's fatal", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    const r = await creditPurchase({ playerId: "player-1", packKey: "pack120", sparks: 12_000, amountInr: 120, razorpayPaymentId: "pay_x" });
    expect(r.status).toBe(502);
  });
});

// 2026-08-27 (docs/2026-08-27_PRD_SparksPage.md §3): the platform's debit
// answer carries { charged, balance }. billSparks now RETURNS it so the chat
// route can show a receipt — still never awaited on the hot path, still
// never throws.
describe("billSparks — returns the platform's receipt", () => {
  const debit = { sessionToken: "jwt", replyId: "r1", seq: 0, kind: "chat", usage: { model: "m", tokensIn: 1, tokensOut: 1 } };
  it("R.1 resolves { charged, balance } from a 200", async () => {
    fetchMock.mockImplementation(() => okJson({ charged: 12, balance: 288, gauge: "good" }));
    expect(await billSparks(debit)).toEqual({ charged: 12, balance: 288 });
  });
  it("R.2 resolves null on a rejected debit or a malformed body — never throws", async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ status: 500, json: () => Promise.resolve({}) } as unknown as Response));
    expect(await billSparks(debit)).toBeNull();
    fetchMock.mockImplementation(() => Promise.reject(new Error("down")));
    expect(await billSparks(debit)).toBeNull();
  });
});
