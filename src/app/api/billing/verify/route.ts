// POST /api/billing/verify — verify the Razorpay Checkout handler response client-side.
// This is a fast-path confirmation for the UI; the webhook (/api/billing/webhook) is the source
// of truth. Fail-closed: bad signature ⇒ 400 and nothing is marked paid.
//
// 2026-07-27 Phase 5: a verified Sparks-pack payment credits the platform
// ledger via the partner bridge (creditPurchase), using the playerId captured
// at order-creation time (PaymentRecord.playerId — see order/route.ts).
// periodEndsAt is now always null: packs aren't time-based entitlements, so
// the concept that used to distinguish a "real plan" from the CUSTOM_PLAN_KEY
// pay-any-amount charge no longer applies to any plan key. If the Sparks
// credit itself fails, the payment is STILL reported as paid (it genuinely
// succeeded) with `pending: true` — never tell a paying user their payment
// failed. The webhook (source of truth) retries the same credit and, unlike
// here, throws on failure so Razorpay's own retry mechanism heals it.

import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/auth-identity";
import { RazorpayGateway } from "@/lib/razorpay";
import { SqlitePaymentStore } from "@/lib/db";
import { findPack, CUSTOM_PLAN_KEY } from "@/lib/billing.config";
import { creditPurchase } from "@/lib/sparks-bridge";

export const runtime = "nodejs";

const gateway = new RazorpayGateway();
const payments = new SqlitePaymentStore();

export async function POST(req: NextRequest) {
  const userId = await resolveUserId();
  if (!userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  let body: {
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const orderId = body.razorpay_order_id ?? "";
  const paymentId = body.razorpay_payment_id ?? "";
  const signature = body.razorpay_signature ?? "";
  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  if (!gateway.verifyPaymentSignature({ orderId, paymentId, signature })) {
    console.warn(`[api/billing/verify] ⛔ bad signature order=${orderId}`);
    return NextResponse.json({ status: "failed" }, { status: 400 });
  }

  // getByOrderId/markPaid were previously unguarded (2026-07-17): a DB error
  // here — after a signature-verified, legitimate payment — used to 500 with
  // no log line naming what failed, same generic shape as every other error.
  // The webhook is still the source of truth and will retry independently;
  // this just makes THIS path's failure diagnosable from app.log alone.
  try {
    // The order must exist and belong to this user — don't let one user confirm another's order.
    const record = payments.getByOrderId(orderId);
    if (!record || record.userId !== userId) {
      console.warn(`[api/billing/verify] ⛔ order not found / wrong owner order=${orderId}`);
      return NextResponse.json({ error: "unknown_order" }, { status: 404 });
    }

    // No plan key grants a time-based access period anymore — Sparks packs
    // are metered, not periodDays entitlements (see order/route.ts).
    payments.markPaid(orderId, paymentId, null);

    let sparksCredited = 0;
    let pending = false;
    if (record.planKey !== CUSTOM_PLAN_KEY) {
      const pack = findPack(record.planKey);
      if (pack && record.playerId) {
        const result = await creditPurchase({
          playerId: record.playerId,
          packKey: pack.key,
          sparks: pack.sparks,
          amountInr: pack.amountPaise / 100,
          razorpayPaymentId: paymentId,
        });
        if (result.status === 200) {
          sparksCredited = pack.sparks;
        } else {
          pending = true;
          console.error(`[api/billing/verify] ⚠ sparks credit pending order=${orderId} bridgeStatus=${result.status}`);
        }
      } else if (pack) {
        // No playerId on the record — a pre-migration row, or a genuine bug
        // upstream. The payment stands (it succeeded); log loudly so it gets
        // manually reconciled, since the webhook will hit the same gap.
        console.error(`[api/billing/verify] ✖ pack order but no playerId on record order=${orderId} plan=${record.planKey}`);
        pending = true;
      }
    }

    console.log(`[api/billing/verify] ✓ paid order=${orderId} user=${userId} sparksCredited=${sparksCredited}`);
    return NextResponse.json({ status: "paid", sparksCredited, pending });
  } catch (err) {
    console.error(`[api/billing/verify] ✖ DB error order=${orderId} user=${userId}: ${(err as Error).message}`);
    return NextResponse.json({ error: "verify_failed" }, { status: 500 });
  }
}
