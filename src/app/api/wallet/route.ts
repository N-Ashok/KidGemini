// [api/wallet] Kid-safe Sparks wallet (PRD-SPARKS Phase 4).
// GET  → celebration payload from the platform ledger: credits-only history,
//        earned total, games built, gauge ('good'|'low'), referral code.
//        Deliberately NO exact balance and NO debits — celebrate up-numbers;
//        precision lives in the Parent view (owner decision 2026-07-25).
// POST → { code } coupon redemption (the kid-visible earn action).

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/ariantra-session";
import { fetchWallet, redeemCoupon } from "@/lib/sparks-bridge";

export const dynamic = "force-dynamic";

function sessionToken(): string {
  return cookies().get(SESSION_COOKIE)?.value ?? "";
}

export async function GET(): Promise<NextResponse> {
  const token = sessionToken();
  if (!token) return NextResponse.json({ error: "signin_required" }, { status: 401 });
  const r = await fetchWallet(token);
  return NextResponse.json(r.data, { status: r.status });
}

export async function POST(req: Request): Promise<NextResponse> {
  const token = sessionToken();
  if (!token) return NextResponse.json({ error: "signin_required" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  if (typeof body.code !== "string" || !body.code.trim()) {
    return NextResponse.json({ error: "Enter a coupon code" }, { status: 422 });
  }
  const r = await redeemCoupon(token, body.code);
  return NextResponse.json(r.data, { status: r.status });
}
