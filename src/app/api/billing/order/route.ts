// POST /api/billing/order — create a Razorpay order for a signed-in user.
// Fail-closed: unauthenticated callers get 401 before any Razorpay call. Returns the order id +
// publishable keyId so the browser can open Checkout. The key SECRET never leaves the server.

import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/auth-identity";
import { RazorpayGateway } from "@/lib/razorpay";
import { SqlitePaymentStore } from "@/lib/db";
import { findPlan, CURRENCY, CUSTOM_PLAN_KEY, validateCustomAmountPaise } from "@/lib/billing.config";

export const runtime = "nodejs";

const gateway = new RazorpayGateway();
const payments = new SqlitePaymentStore();

export async function POST(req: NextRequest) {
  const userId = await resolveUserId();
  if (!userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  let body: { planKey?: string; amountPaise?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Two shapes: a fixed plan ({ planKey }) or an arbitrary pay-any-amount charge
  // ({ amountPaise }). The custom amount is validated server-side (the browser's
  // help is never trusted) and carries the CUSTOM_PLAN_KEY sentinel, which grants
  // no entitlement downstream (verify/webhook stamp no period; latestForUser skips it).
  let amountPaise: number;
  let planKey: string;
  let planLabel: string;
  if (body.amountPaise !== undefined) {
    const amt = validateCustomAmountPaise(body.amountPaise);
    if (amt === null) return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
    amountPaise = amt;
    planKey = CUSTOM_PLAN_KEY;
    planLabel = "Custom amount";
  } else {
    const plan = findPlan(body.planKey ?? "");
    if (!plan) return NextResponse.json({ error: "unknown_plan" }, { status: 400 });
    amountPaise = plan.amountPaise;
    planKey = plan.key;
    planLabel = plan.label;
  }

  try {
    const order = await gateway.createOrder({
      amountPaise,
      currency: CURRENCY,
      receipt: `kg_${userId.slice(0, 24)}_${Date.now()}`,
      notes: { userId, planKey },
    });
    payments.create({
      userId,
      planKey,
      amountPaise,
      currency: CURRENCY,
      razorpayOrderId: order.id,
    });
    console.log(`[api/billing/order] ✓ order=${order.id} user=${userId} plan=${planKey}`);
    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: gateway.keyId,
      planLabel,
    });
  } catch (err) {
    console.error(`[api/billing/order] ✖ ${(err as Error).message}`);
    return NextResponse.json({ error: "order_failed" }, { status: 502 });
  }
}
