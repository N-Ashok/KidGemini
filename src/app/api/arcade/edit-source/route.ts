export const dynamic = "force-dynamic";
/**
 * [api/arcade/edit-source] GET ?slug= — the seed for an edit chat
 * (PRD-STUDIO-CHAT-EDIT, revised 2026-07-24: Ari is the editor). Fetches the
 * signed-in owner's CLEAN game code (platform strips its own SDK/SEO/overlay
 * injections) from the platform's partner `getCode` action, so Studio's
 * "✏️ Edit in Games-Lab" can open a new chat with the live game loaded.
 *
 * Gates, fail-closed: the SSO `ariantra_session` cookie must be present
 * (401 otherwise — the UI says to sign in), and the PLATFORM re-verifies the
 * session AND ownership server-side (a non-owner gets the same 404 as a
 * missing game). Read-only: no PIN needed — publishing any edit still runs
 * the full parent-PIN publish gate.
 *
 * → { eligible: true, html, name, slug }
 * → { eligible: false, reason, name?, slug } (multi-file / deleted / admin-paused / no-code)
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/ariantra-session";
import { partner } from "@/lib/arcade-partner";

const SLUG_RE = /^[a-z0-9-]{2,40}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionToken = cookies().get(SESSION_COOKIE)?.value ?? "";
  if (!sessionToken) return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const slug = (req.nextUrl.searchParams.get("slug") ?? "").trim();
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "bad_slug" }, { status: 422 });
  const { status, data } = await partner({ getCode: true, sessionToken, slug });
  return NextResponse.json(data, { status });
}
