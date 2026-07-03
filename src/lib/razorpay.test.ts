// Unit tests for the Razorpay gateway. The signature checks are the security boundary here
// (the payment analog of the safety gate), so they're tested for accept / tamper / missing /
// fail-closed-no-secret. createOrder is tested with a mocked fetch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("server-only", () => ({}));

import { RazorpayGateway } from "./razorpay";

const KEY_ID = "rzp_test_123";
const KEY_SECRET = "test_key_secret";
const WEBHOOK_SECRET = "test_webhook_secret";

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  vi.unstubAllGlobals();
});

describe("verifyPaymentSignature (Checkout handler)", () => {
  it("accepts a correctly signed order|payment", () => {
    const g = new RazorpayGateway();
    const signature = createHmac("sha256", KEY_SECRET).update("order_1|pay_1").digest("hex");
    expect(g.verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature })).toBe(true);
  });

  it("rejects a tampered payment id", () => {
    const g = new RazorpayGateway();
    const signature = createHmac("sha256", KEY_SECRET).update("order_1|pay_1").digest("hex");
    expect(g.verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_2", signature })).toBe(false);
  });

  it("rejects an empty/missing signature", () => {
    const g = new RazorpayGateway();
    expect(g.verifyPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature: "" })).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ event: "payment.captured" });

  it("accepts a body signed with the webhook secret", () => {
    const g = new RazorpayGateway();
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    expect(g.verifyWebhookSignature(body, signature)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const g = new RazorpayGateway();
    const signature = createHmac("sha256", "wrong_secret").update(body).digest("hex");
    expect(g.verifyWebhookSignature(body, signature)).toBe(false);
  });

  it("fails closed when no webhook secret is configured", () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const g = new RazorpayGateway();
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    expect(g.verifyWebhookSignature(body, signature)).toBe(false);
  });
});

describe("createOrder", () => {
  it("POSTs to Razorpay /orders with basic auth and returns the order", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "order_abc", amount: 69_900, currency: "INR" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const g = new RazorpayGateway();
    const order = await g.createOrder({ amountPaise: 69_900, currency: "INR", receipt: "r1" });

    expect(order).toEqual({ id: "order_abc", amount: 69_900, currency: "INR" });
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/orders");
    expect((opts.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(JSON.parse(opts.body as string)).toMatchObject({ amount: 69_900, currency: "INR", receipt: "r1" });
  });

  it("throws when Razorpay returns a non-OK response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    vi.stubGlobal("fetch", fetchMock);

    const g = new RazorpayGateway();
    await expect(g.createOrder({ amountPaise: 69_900, currency: "INR", receipt: "r1" })).rejects.toThrow();
  });
});
