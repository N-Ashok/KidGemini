export const dynamic = "force-dynamic";
/**
 * [api/parent/games] POST — Parent-zone multiplayer on/off toggle
 * (PRD-MULTIPLAYER.md Phase 4). The first on/off toggle on this page — no
 * prior precedent to extend, built fresh here, same gate SHAPE as
 * arcade/publish (SSO session + PIN-verified parent of THIS family), since
 * flipping a published game's multiplayer capability is a safety-adjacent
 * moderation action, not a read.
 *
 * Bodies: { list: true }                                    → { games: [{slug,name,status,multiplayer}] }
 *         { toggleMultiplayer: true, slug, multiplayer }    → { slug, multiplayer }
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifyAriantraSession } from "@/lib/ariantra-session";
import { getVerifiedParentAccount } from "@/lib/parent-session.server";

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";

interface Body {
  list?: boolean;
  toggleMultiplayer?: boolean;
  slug?: string;
  multiplayer?: boolean;
}

async function partner(payload: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const res = await fetch(`${PLATFORM_BASE}/api/studio/partner/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": secret },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 403) {
    return { status: 502, data: { error: "The Arcade server said no — a grown-up should check that kidgemini and the platform share the same secret." } };
  }
  return { status: res.status, data };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as Body;
  const rawSession = cookies().get(SESSION_COOKIE)?.value ?? "";

  if (body.list === true) {
    if (!rawSession) return NextResponse.json({ error: "signed_out" }, { status: 401 });
    const { status, data } = await partner({ list: true, sessionToken: rawSession });
    return NextResponse.json(data, { status });
  }

  if (body.toggleMultiplayer === true) {
    // Gate 1: signed-in family account.
    const secret = process.env.AUTH_JWT_SECRET ?? "";
    const session = secret ? await verifyAriantraSession(rawSession, secret) : null;
    if (!session) return NextResponse.json({ error: "signed_out" }, { status: 401 });

    // Gate 2: a PIN-verified parent of THIS family (same ownership-match
    // fix as arcade/publish — a parent session from another family can never
    // toggle a different family's game).
    const parentAccount = await getVerifiedParentAccount();
    if (!parentAccount || parentAccount !== session.userId) {
      return NextResponse.json({ error: "parent_required" }, { status: 403 });
    }

    const { status, data } = await partner({
      toggleMultiplayer: true,
      sessionToken: rawSession,
      slug: body.slug,
      multiplayer: body.multiplayer === true,
    });
    return NextResponse.json(data, { status });
  }

  return NextResponse.json({ error: "Nothing to do" }, { status: 422 });
}
