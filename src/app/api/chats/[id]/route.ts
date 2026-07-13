// Server-side chat history (TECH_DEBT #26), single conversation.
// GET /api/chats/:id → the full conversation (messages incl. game HTML),
//     404 unless it belongs to this request's identity (fail closed).
// PUT /api/chats/:id { convo } → write-through upsert after a turn completes.

import { NextRequest, NextResponse } from "next/server";
import { SqliteChatHistoryStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";
import { sanitizeConversation } from "@/lib/chat-history";

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
