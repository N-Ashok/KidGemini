// Share a conversation (2026-08-06_PRD_ShareConversation.md). AUTH CODE —
// fail closed.
// POST   /api/chats/:id/share → { url } — requires BOTH the chat owner's
//        identity AND a PIN-verified parent session (same ari_parent cookie
//        gate as publish; the PIN itself never rides on this request).
//        Idempotent: a live token is returned, not replaced — so re-sharing
//        after a revoke mints a FRESH link while old ones stay dead.
// DELETE /api/chats/:id/share → revoke. Owner-only, no PIN: turning a link
//        OFF only reduces exposure.

import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { SqliteChatHistoryStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";
import { getVerifiedParentAccount } from "@/lib/parent-session.server";

export const runtime = "nodejs";

const store = new SqliteChatHistoryStore();

interface IdParams {
  params: { id: string };
}

/** The app's canonical public origin — same value as layout.tsx's
 *  metadataBase. Fallback of last resort below, never the first choice. */
const CANONICAL_ORIGIN = "https://games-lab.ariantra.com";

/** Owner UAT 2026-08-06: req.nextUrl.origin behind the Caddy reverse proxy is
 *  the box-INTERNAL origin — the live sheet handed out
 *  https://localhost:3001/share/chat/… . Build the public URL from the
 *  forwarded headers instead; if nothing trustworthy arrived (only a
 *  localhost-ish host), production falls back to the canonical host so an
 *  internal origin can never leak into a link a kid forwards. Dev keeps
 *  localhost — that's genuinely where the page is. */
function publicOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  if (host && !/^(localhost|127\.)/i.test(host)) return `${proto}://${host}`;
  return process.env.NODE_ENV === "production" ? CANONICAL_ORIGIN : req.nextUrl.origin;
}

function shareUrl(req: NextRequest, token: string): string {
  return `${publicOrigin(req)}/share/chat/${token}`;
}

export async function POST(req: NextRequest, { params }: IdParams) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "no_identity" }, { status: 401 });
  const parent = await getVerifiedParentAccount();
  if (!parent) return NextResponse.json({ error: "parent_required" }, { status: 403 });
  const state = store.getShareToken(userId, params.id);
  if (!state) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (state.shareToken) return NextResponse.json({ url: shareUrl(req, state.shareToken) });
  const token = randomBytes(16).toString("hex");
  if (!store.setShareToken(userId, params.id, token)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ url: shareUrl(req, token) });
}

export async function DELETE(req: NextRequest, { params }: IdParams) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "no_identity" }, { status: 401 });
  if (!store.setShareToken(userId, params.id, null)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
