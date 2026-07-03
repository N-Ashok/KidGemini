// Razorpay gateway. Single responsibility: talk to Razorpay and verify its signatures.
// Knows nothing about our DB or routes. Server-only — the key secret must never reach the client.
//
// Uses the REST API directly (Basic auth) so we don't add an SDK dependency. Signature checks
// use Node's crypto with a constant-time compare and fail closed (missing secret/signature →
// reject) — they are the payment analog of the safety gate.

import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { GatewayOrder, PaymentGateway } from "@/types/billing.types";

const RAZORPAY_API = "https://api.razorpay.com/v1";

export class RazorpayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazorpayError";
  }
}

function hmacHex(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time hex compare. Different lengths / empty / non-hex → false (never throws). */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export class RazorpayGateway implements PaymentGateway {
  private readonly keyIdValue = process.env.RAZORPAY_KEY_ID ?? "";
  private readonly keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
  private readonly webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

  get keyId(): string {
    if (!this.keyIdValue) throw new RazorpayError("RAZORPAY_KEY_ID is not set");
    return this.keyIdValue;
  }

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder> {
    if (!this.keyIdValue || !this.keySecret) {
      throw new RazorpayError("Razorpay API keys are not set");
    }
    const auth = Buffer.from(`${this.keyIdValue}:${this.keySecret}`).toString("base64");
    const res = await fetch(`${RAZORPAY_API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt,
        notes: input.notes ?? {},
        payment_capture: 1,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new RazorpayError(`createOrder failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { id: string; amount: number; currency: string };
    return { id: json.id, amount: json.amount, currency: json.currency };
  }

  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
    if (!this.keySecret) return false; // fail-closed
    const expected = hmacHex(`${input.orderId}|${input.paymentId}`, this.keySecret);
    return safeEqualHex(expected, input.signature ?? "");
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret) return false; // fail-closed: no secret ⇒ can't trust any webhook
    const expected = hmacHex(rawBody, this.webhookSecret);
    return safeEqualHex(expected, signature ?? "");
  }
}
