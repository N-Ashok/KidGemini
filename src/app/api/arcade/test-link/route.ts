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
import { partner } from "@/lib/arcade-partner";

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

  const { status, data } = await partner({ createTestLink: true, sessionToken: rawSession, name, html: body.html });
  return NextResponse.json(data, { status });
}
