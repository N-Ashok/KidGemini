export const dynamic = "force-dynamic";
/**
 * [api/arcade/publish] POST — "🚀 Put it in the Arcade" (kid publishes their
 * generated game to games.ariantra.com). Two gates, fail-closed:
 *   1. Parent PIN (same PARENT_PIN as the parent dashboard) — a grown-up
 *      approves putting the game on the public internet.
 *   2. The SSO `ariantra_session` cookie must verify — the game publishes
 *      under the family's Ariantra account. Signed out → 401 (UI offers
 *      "Sign in with Google").
 * The raw session token is then forwarded to the platform's partner endpoint
 * (server-to-server, guarded by the shared AUTH_JWT_SECRET), which creates +
 * publishes the game — auto-score, leaderboard, SEO, thumbnail all included.
 *
 * Bodies:  { check: true, name }                → { free, slug, suggestions }
 *          { name, html, pin }                  → { url, slug }
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifyAriantraSession } from "@/lib/ariantra-session";
import { nameToSlug } from "@/lib/arcade";

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";

interface Body {
  check?: boolean;
  name?: string;
  html?: string;
  pin?: string;
}

async function partner(payload: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const res = await fetch(`${PLATFORM_BASE}/api/studio/partner/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": secret },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as Body;
  const name = (body.name ?? "").trim().slice(0, 60);
  const slug = nameToSlug(name);
  if (!slug) {
    return NextResponse.json({ error: "Pick a name with some letters or numbers in it 🙂" }, { status: 422 });
  }

  // Availability check — no gates needed (harmless, and the kid is still
  // typing). The session rides along so the platform can answer "that taken
  // name is YOUR game" → the UI offers Update instead of a rename.
  if (body.check === true) {
    const sessionToken = cookies().get(SESSION_COOKIE)?.value ?? "";
    const { status, data } = await partner({ check: true, slug, ...(sessionToken ? { sessionToken } : {}) });
    return NextResponse.json({ slug, ...data }, { status });
  }

  // Gate 1: grown-up PIN (same family secret as the parent dashboard).
  if (!process.env.PARENT_PIN || body.pin !== process.env.PARENT_PIN) {
    return NextResponse.json({ error: "wrong_pin" }, { status: 403 });
  }

  // Gate 2: signed-in family account (SSO cookie) — verified here for a fast
  // friendly 401, and verified AGAIN by the platform (its own fail-closed check).
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const rawSession = cookies().get(SESSION_COOKIE)?.value ?? "";
  const session = secret ? await verifyAriantraSession(rawSession, secret) : null;
  if (!session) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }

  if (!body.html || !/<\w+[\s>/]/.test(body.html)) {
    return NextResponse.json({ error: "That game looks empty — generate it again and retry." }, { status: 422 });
  }

  const { status, data } = await partner({
    sessionToken: rawSession,
    name,
    slug,
    files: { "index.html": { data: body.html, encoding: "utf8" } },
  });
  return NextResponse.json({ slug, ...data }, { status });
}
