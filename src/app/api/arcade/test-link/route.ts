export const dynamic = "force-dynamic";
/**
 * [api/arcade/test-link] POST — "🎮 Invite a friend to test" (PRD-MULTIPLAYER.md
 * Phase 4, §Preview-pane hosting). Deliberately ONE gate, not two:
 *   1. The SSO `ariantra_session` cookie must verify — same identity check as
 *      publish, so this isn't callable anonymously.
 * Unlike /api/arcade/publish, there is NO parent-PIN gate here: nothing is
 * published, no Game record, no slug, no catalog listing — the ephemeral test
 * link expires with the room and is never public beyond whoever has the link
 * (same friends-by-link trust model as the rest of this feature).
 *
 * Body: { name, html } → { id, url }
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifyAriantraSession } from "@/lib/ariantra-session";

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";

interface Body {
  name?: string;
  html?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as Body;

  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const rawSession = cookies().get(SESSION_COOKIE)?.value ?? "";
  const session = secret ? await verifyAriantraSession(rawSession, secret) : null;
  if (!session) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }

  if (!body.html || !/<\w+[\s>/]/.test(body.html)) {
    return NextResponse.json({ error: "That game looks empty — generate it again and retry." }, { status: 422 });
  }
  const name = (body.name ?? "My game").trim().slice(0, 60);

  const res = await fetch(`${PLATFORM_BASE}/api/studio/partner/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": secret },
    body: JSON.stringify({ createTestLink: true, sessionToken: rawSession, name, html: body.html }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Same rationale as the publish route (BUG-FIX-LOG 2026-07-11): a secret
  // mismatch/misconfigured ARIANTRA_API_BASE must not collide with our own
  // 401/422 shapes.
  if (res.status === 403) {
    return NextResponse.json(
      { error: "The Arcade server said no — a grown-up should check that kidgemini and the platform share the same secret." },
      { status: 502 },
    );
  }
  return NextResponse.json(data, { status: res.status });
}
