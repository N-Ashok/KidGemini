// POST /api/billing/order — create a Razorpay order for a signed-in user.
// Fail-closed: unauthenticated callers get 401 before any Razorpay call. Returns the order id +
// publishable keyId so the browser can open Checkout. The key SECRET never leaves the server.

import { NextRequest, NextResponse } from "next/server";
import { resolveUserId, resolvePlayerId } from "@/lib/auth-identity";
import { RazorpayGateway } from "@/lib/razorpay";
import { SqlitePaymentStore } from "@/lib/db";
import { findPack, CURRENCY, CUSTOM_PLAN_KEY, validateCustomAmountPaise } from "@/lib/billing.config";
import { SESSION_COOKIE } from "@/lib/ariantra-session";
import { fetchGate } from "@/lib/sparks-bridge";

export const runtime = "nodejs";

const gateway = new RazorpayGateway();
const payments = new SqlitePaymentStore();

export async function POST(req: NextRequest) {
  const userId = await resolveUserId();
  if (!userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  // Captured now (a live session is guaranteed here) so verify/webhook can
  // credit the Sparks purchase later without needing a live session cookie —
  // see PaymentRecord.playerId.
  const playerId = await resolvePlayerId();

  let body: { planKey?: string; amountPaise?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Two shapes: a fixed Sparks pack ({ planKey }) or an arbitrary pay-any-amount
  // charge ({ amountPaise }). The custom amount is validated server-side (the
  // browser's help is never trusted) and carries the CUSTOM_PLAN_KEY sentinel,
  // which credits no Sparks downstream (verify/webhook skip the ledger bridge;
  // latestForUser skips it too). The request field stays `planKey` — renaming
  // it would be a breaking change to an already-public request shape for a
  // rename that gains nothing.
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
    const pack = findPack(body.planKey ?? "");
    if (!pack) return NextResponse.json({ error: "unknown_plan" }, { status: 400 });
    // 2026-08-07: the ₹120 trial pack is purchasable ONCE per player — checked
    // at ORDER time (refusing after payment would strand real money), platform
    // ledger as the source of truth. Fail CLOSED on a gate outage: a kid can
    // wait a minute to buy a trial; a double-sold trial can't be unsold.
    if (pack.trialOnce) {
      const sessionToken = req.cookies.get(SESSION_COOKIE)?.value ?? "";
      const gate = sessionToken ? await fetchGate(sessionToken) : { status: 401, data: {} as { trialUsed?: boolean } };
      if (gate.status !== 200) return NextResponse.json({ error: "trial_check_unavailable" }, { status: 502 });
      if (gate.data.trialUsed) return NextResponse.json({ error: "trial_used" }, { status: 400 });
    }
    amountPaise = pack.amountPaise;
    planKey = pack.key;
    planLabel = pack.label;
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
      playerId,
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
