// POST /api/billing/order — create a Razorpay order for a signed-in user.
// Fail-closed: unauthenticated callers get 401 before any Razorpay call. Returns the order id +
// publishable keyId so the browser can open Checkout. The key SECRET never leaves the server.

import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "@/lib/auth-identity";
import { RazorpayGateway } from "@/lib/razorpay";
import { SqlitePaymentStore } from "@/lib/db";
import { findPlan, CURRENCY } from "@/lib/billing.config";

export const runtime = "nodejs";

const gateway = new RazorpayGateway();
const payments = new SqlitePaymentStore();

export async function POST(req: NextRequest) {
  const userId = await resolveUserId();
  if (!userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  let body: { planKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const plan = findPlan(body.planKey ?? "");
  if (!plan) return NextResponse.json({ error: "unknown_plan" }, { status: 400 });

  try {
    const order = await gateway.createOrder({
      amountPaise: plan.amountPaise,
      currency: CURRENCY,
      receipt: `kg_${userId.slice(0, 24)}_${Date.now()}`,
      notes: { userId, planKey: plan.key },
    });
    payments.create({
      userId,
      planKey: plan.key,
      amountPaise: plan.amountPaise,
      currency: CURRENCY,
      razorpayOrderId: order.id,
    });
    console.log(`[api/billing/order] ✓ order=${order.id} user=${userId} plan=${plan.key}`);
    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: gateway.keyId,
      planLabel: plan.label,
    });
  } catch (err) {
    console.error(`[api/billing/order] ✖ ${(err as Error).message}`);
    return NextResponse.json({ error: "order_failed" }, { status: 502 });
  }
}
