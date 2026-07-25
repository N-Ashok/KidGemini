// [api/parent/sparks] Parent-side Sparks (PRD-SPARKS Phase 4). Rendered
// inside the PIN-gated Parent tab.
// GET  → the FULL statement: every transaction (spends included, with tokens
//        + ₹ cost in meta) and the exact balance — 100% clarity, addressed to
//        the person who pays.
// POST → { gameSlug, platform, url } parent-submitted social share of the
//        kid's game on Ariantra's Twitter/Instagram (parents only — kids
//        never touch social surfaces). Once per game per platform.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/ariantra-session";
import { fetchParentStatement, submitSocialShare } from "@/lib/sparks-bridge";

export const dynamic = "force-dynamic";

function sessionToken(): string {
  return cookies().get(SESSION_COOKIE)?.value ?? "";
}

export async function GET(): Promise<NextResponse> {
  const token = sessionToken();
  if (!token) return NextResponse.json({ error: "signin_required" }, { status: 401 });
  const r = await fetchParentStatement(token);
  return NextResponse.json(r.data, { status: r.status });
}

export async function POST(req: Request): Promise<NextResponse> {
  const token = sessionToken();
  if (!token) return NextResponse.json({ error: "signin_required" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { gameSlug?: unknown; platform?: unknown; url?: unknown };
  if (typeof body.gameSlug !== "string" || typeof body.platform !== "string" || typeof body.url !== "string") {
    return NextResponse.json({ error: "gameSlug, platform and url are required" }, { status: 422 });
  }
  const r = await submitSocialShare(token, body.gameSlug, body.platform, body.url);
  return NextResponse.json(r.data, { status: r.status });
}
