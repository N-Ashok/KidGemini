// Server-side chat history (TECH_DEBT #26), single conversation.
// GET    /api/chats/:id → the full conversation (messages incl. game HTML),
//        404 unless it belongs to this request's identity (fail closed).
// PUT    /api/chats/:id { convo } → write-through upsert after a turn completes.
// PATCH  /api/chats/:id { title?, pinned? } → rename and/or pin (owner ask
//        2026-08-06, sidebar ⋮ menu). Rename never bumps recency; both are
//        fail-closed 404 on a foreign/unknown/deleted id, same as GET.
// DELETE /api/chats/:id → SOFT delete (owner ask 2026-07-26): hides the chat
//        from this account's view; the row stays in the system. 404 for a
//        foreign/unknown/already-deleted id (fail closed, same as GET).

import { NextRequest, NextResponse } from "next/server";
import { SqliteChatHistoryStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";
import { sanitizeConversation, MAX_TITLE } from "@/lib/chat-history";
import { TurnLog, adoptTraceId } from "@/lib/turn-log";

export const runtime = "nodejs";

const store = new SqliteChatHistoryStore();

interface IdParams {
  params: { id: string };
}

export async function GET(req: NextRequest, { params }: IdParams) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const convo = store.get(userId, params.id);
  if (!convo) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ convo });
}

export async function PUT(req: NextRequest, { params }: IdParams) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "no_identity" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { convo?: unknown };
  const convo = sanitizeConversation(body.convo);
  if (!convo || convo.id !== params.id) {
    return NextResponse.json({ error: "invalid conversation" }, { status: 400 });
  }
  // ── B2 INSTRUMENT (2026-08-17, KNOWN_BUGS #24) ──────────────────────────
  //
  // The bug: a self-heal produced a fixed game, and the STORED source did not
  // change. Observed twice — stored frozen at 60,543 while repairs produced
  // 60,531 and 60,282, then frozen at 70,718 while a repair produced 71,955 —
  // and yet the FIRST repair of the session did persist (58,895 was picked up
  // by the next edit). So it is conditional, and the plan for it says
  // explicitly: root-cause it, do not guess.
  //
  // It is not guessable from the code alone, and it cannot be reproduced on
  // demand. What it needs is the one number nobody has ever had: what actually
  // reached storage, next to what the repair produced. `api/repair` already
  // logs `stage=deliver outChars=`; this logs the counterpart. Comparing the
  // two on one `trace=` settles it — either the write never arrives (a client
  // path that never fires), or it arrives with the OLD bytes (a stale-state
  // race), or it arrives correctly and something later overwrites it.
  //
  // Sizes and ids only — never a child's text or their game's contents.
  const log = new TurnLog("api/chats", adoptTraceId(req.headers.get("x-ari-trace")), { userId });
  const games = convo.messages.filter((m) => typeof m.artifactHtml === "string" && m.artifactHtml.length > 0);
  const newest = games[games.length - 1];
  log.ok("persist", {
    convo: convo.id,
    messages: convo.messages.length,
    games: games.length,
    newestGame: newest?.id,
    chars: newest?.artifactHtml?.length,
  });
  store.upsert(userId, convo, Date.now());
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, { params }: IdParams) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "no_identity" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { title?: unknown; pinned?: unknown };
  const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE) : undefined;
  const pinned = typeof body.pinned === "boolean" ? body.pinned : undefined;
  if ((typeof body.title === "string" && !title) || (title === undefined && pinned === undefined)) {
    return NextResponse.json({ error: "title or pinned required" }, { status: 400 });
  }
  if (title !== undefined && !store.rename(userId, params.id, title)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (pinned !== undefined && !store.setPinned(userId, params.id, pinned, Date.now())) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: IdParams) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "no_identity" }, { status: 401 });
  const deleted = store.softDelete(userId, params.id, Date.now());
  if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
