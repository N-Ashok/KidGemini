// POST /api/billing/webhook — Razorpay server-to-server callback. The SOURCE OF TRUTH for
// "did this payment succeed". No user session here; the HMAC signature IS the authentication.
// Fail-closed: invalid/missing signature ⇒ 400 and no state change. Idempotent on the event id
// (Razorpay retries). Reads the RAW body — the signature is over the exact bytes.
//
// 2026-07-27 Phase 5: this is the SOURCE-OF-TRUTH Sparks credit path (see
// verify/route.ts for the fast-path UI confirm, which degrades gracefully
// instead of throwing). A bridge failure here THROWS — same as the existing
// markPaid error handling below — so Razorpay's own automatic webhook retry
// keeps calling until the ledger accepts the credit. Safe to retry: the
// ledger's idempotency key is razorpayPaymentId, so a repeat credits once.

import { NextRequest, NextResponse } from "next/server";
import { RazorpayGateway } from "@/lib/razorpay";
import { SqlitePaymentStore } from "@/lib/db";
import { findPack, CUSTOM_PLAN_KEY } from "@/lib/billing.config";
import { creditPurchase } from "@/lib/sparks-bridge";

export const runtime = "nodejs";

const gateway = new RazorpayGateway();
const payments = new SqlitePaymentStore();

const PAID_EVENTS = new Set(["payment.captured", "order.paid"]);

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  if (!gateway.verifyWebhookSignature(raw, signature)) {
    console.warn(`[api/billing/webhook] ⛔ invalid signature`);
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // Idempotency — Razorpay retries deliver the same event id; process it at most once.
  // isNewEvent/getByOrderId/markPaid were previously unguarded (2026-07-17):
  // a thrown DB error here still 500s exactly as before (so Razorpay's own
  // retry semantics keep working unchanged) — the only change is a log line
  // naming the event before it propagates, instead of a bare stack trace.
  const eventId = req.headers.get("x-razorpay-event-id") ?? "";
  let isNew: boolean;
  try {
    isNew = eventId ? payments.isNewEvent(eventId) : true;
  } catch (err) {
    console.error(`[api/billing/webhook] ✖ isNewEvent failed event=${eventId}: ${(err as Error).message}`);
    throw err;
  }
  if (!isNew) {
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
      try {
        const record = payments.getByOrderId(orderId);
        // No plan key grants a time-based access period anymore — see
        // verify/route.ts's comment (Sparks packs are metered, not periodDays).
        const updated = payments.markPaid(orderId, paymentId, null);
        console.log(
          `[api/billing/webhook] ${updated ? "✓ paid" : "⚠ unknown order"} event=${event.event} order=${orderId}`,
        );

        if (record && record.planKey !== CUSTOM_PLAN_KEY) {
          const pack = findPack(record.planKey);
          if (pack && record.playerId) {
            const result = await creditPurchase({
              playerId: record.playerId,
              packKey: pack.key,
              sparks: pack.sparks,
              amountInr: pack.amountPaise / 100,
              razorpayPaymentId: paymentId,
            });
            if (result.status !== 200) {
              throw new Error(`sparks credit failed (bridge status ${result.status}) order=${orderId}`);
            }
            console.log(`[api/billing/webhook] ✓ sparks credited order=${orderId} pack=${pack.key}`);
          } else if (pack) {
            // No playerId on the record — pre-migration row or an upstream bug.
            // Throw so this is visible (via Razorpay's retry alerts) rather than
            // silently leaving a paid order with no Sparks credited.
            throw new Error(`pack order has no playerId order=${orderId} plan=${record.planKey}`);
          }
        }
      } catch (err) {
        console.error(`[api/billing/webhook] ✖ payment processing failed event=${event.event} order=${orderId}: ${(err as Error).message}`);
        throw err;
      }
    }
  }

  return NextResponse.json({ status: "ok" });
}
