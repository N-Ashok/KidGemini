// Server-side chat history (TECH_DEBT #26).
// GET  /api/chats?before=<updatedAt>&limit=N → { chats: ConvoSummary[] } —
//      the sidebar's paginated Recents index (titles only, no payloads).
//      Also claims any guest-owned rows into the account the moment both
//      identities show up on the same request (see the claim() call below) —
//      the guest→account merge gap, BUG-FIX-LOG 2026-07-18.
// POST /api/chats { convos: Conversation[] } → one-time device migration
//      (bulk upsert, idempotent). Identity = SSO session or guest cookie;
//      no identity → empty list / 401 on write (fail closed).

import { NextRequest, NextResponse } from "next/server";
import { SqliteChatHistoryStore } from "@/lib/db";
import { resolveChatUser, readGuestId } from "@/lib/chat-identity";
import { sanitizeConversation, LIST_DEFAULT, LIST_MAX, MAX_BULK } from "@/lib/chat-history";
import type { Conversation } from "@/types/chat.types";

export const runtime = "nodejs";

const store = new SqliteChatHistoryStore();

export async function GET(req: NextRequest) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ chats: [] });
  // Guest→account merge gap (BUG-FIX-LOG 2026-07-18): the client-side
  // localStorage migration is one-shot and NOT identity-aware (SYNC_FLAG
  // fires once, usually while still a guest, and never re-runs on login),
  // so a guest's server-side rows were never otherwise claimed. This request
  // is signed in AND still carries the (httpOnly) guest cookie from before
  // login — exactly the moment to fold that guest's history into the
  // account. Idempotent and cheap (indexed no-op) once already claimed.
  if (userId.startsWith("user:")) {
    const guestId = readGuestId(req);
    if (guestId) store.claim(guestId, userId);
  }
  const q = req.nextUrl.searchParams;
  const limit = Math.min(LIST_MAX, Math.max(1, Number(q.get("limit")) || LIST_DEFAULT));
  // Composite cursor = the prior page's last row (before + beforeId together).
  const beforeAt = Number(q.get("before")) || undefined;
  const beforeId = q.get("beforeId") ?? undefined;
  const before = beforeAt !== undefined && beforeId ? { updatedAt: beforeAt, id: beforeId } : undefined;
  return NextResponse.json({ chats: store.list(userId, limit, before) });
}

export async function POST(req: NextRequest) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "no_identity" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { convos?: unknown[] };
  if (!Array.isArray(body.convos)) {
    return NextResponse.json({ error: "convos array required" }, { status: 400 });
  }
  const clean: Conversation[] = [];
  for (const raw of body.convos.slice(0, MAX_BULK)) {
    const c = sanitizeConversation(raw);
    if (c) clean.push(c); // migration is best-effort: skip bad rows, keep good ones
  }
  const saved = store.bulkUpsert(userId, clean, Date.now());
  console.log(`[api/chats] migrated ${saved}/${body.convos.length} convos userId=${userId}`);
  return NextResponse.json({ saved });
}
