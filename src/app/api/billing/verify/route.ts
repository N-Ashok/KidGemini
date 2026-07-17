// POST /api/billing/verify — verify the Razorpay Checkout handler response client-side.
// This is a fast-path confirmation for the UI; the webhook (/api/billing/webhook) is the source
// of truth. Fail-closed: bad signature ⇒ 400 and nothing is marked paid.

import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/auth-identity";
import { RazorpayGateway } from "@/lib/razorpay";
import { SqlitePaymentStore } from "@/lib/db";
import { findPlan } from "@/lib/billing.config";

export const runtime = "nodejs";

const gateway = new RazorpayGateway();
const payments = new SqlitePaymentStore();

const DAY_MS = 86_400_000;

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

    const plan = findPlan(record.planKey);
    const periodEndsAt = Date.now() + (plan?.periodDays ?? 30) * DAY_MS;
    payments.markPaid(orderId, paymentId, periodEndsAt);
    console.log(`[api/billing/verify] ✓ paid order=${orderId} user=${userId}`);
    return NextResponse.json({ status: "paid", periodEndsAt });
  } catch (err) {
    console.error(`[api/billing/verify] ✖ DB error order=${orderId} user=${userId}: ${(err as Error).message}`);
    return NextResponse.json({ error: "verify_failed" }, { status: 500 });
  }
}
