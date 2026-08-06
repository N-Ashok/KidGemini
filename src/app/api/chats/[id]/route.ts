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
