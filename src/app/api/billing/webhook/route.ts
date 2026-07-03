// POST /api/billing/webhook — Razorpay server-to-server callback. The SOURCE OF TRUTH for
// "did this payment succeed". No user session here; the HMAC signature IS the authentication.
// Fail-closed: invalid/missing signature ⇒ 400 and no state change. Idempotent on the event id
// (Razorpay retries). Reads the RAW body — the signature is over the exact bytes.

import { NextRequest, NextResponse } from "next/server";
import { RazorpayGateway } from "@/lib/razorpay";
import { SqlitePaymentStore } from "@/lib/db";
import { findPlan } from "@/lib/billing.config";

export const runtime = "nodejs";

const gateway = new RazorpayGateway();
const payments = new SqlitePaymentStore();

const DAY_MS = 86_400_000;
const PAID_EVENTS = new Set(["payment.captured", "order.paid"]);

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  if (!gateway.verifyWebhookSignature(raw, signature)) {
    console.warn(`[api/billing/webhook] ⛔ invalid signature`);
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // Idempotency — Razorpay retries deliver the same event id; process it at most once.
  const eventId = req.headers.get("x-razorpay-event-id") ?? "";
  if (eventId && !payments.isNewEvent(eventId)) {
    console.log(`[api/billing/webhook] ↺ duplicate event ${eventId} ignored`);
    return NextResponse.json({ status: "duplicate_ignored" });
  }

  let event: {
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (event.event && PAID_EVENTS.has(event.event)) {
    const entity = event.payload?.payment?.entity;
    const orderId = entity?.order_id;
    const paymentId = entity?.id;
    if (orderId && paymentId) {
      const record = payments.getByOrderId(orderId);
      const plan = record ? findPlan(record.planKey) : undefined;
      const periodEndsAt = Date.now() + (plan?.periodDays ?? 30) * DAY_MS;
      const updated = payments.markPaid(orderId, paymentId, periodEndsAt);
      console.log(
        `[api/billing/webhook] ${updated ? "✓ paid" : "⚠ unknown order"} event=${event.event} order=${orderId}`,
      );
    }
  }

  return NextResponse.json({ status: "ok" });
}
