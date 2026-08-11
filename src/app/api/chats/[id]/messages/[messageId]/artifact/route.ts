// One externalized game version, fetched on demand (2026-08-11, the
// chat-history size-cap scalable follow-up — see chat-history.ts's
// splitOldArtifacts). GET /api/chats/:id/messages/:messageId/artifact
// { html } — 404 for anything absent, foreign, or belonging to a
// soft-deleted conversation, same fail-closed contract as GET /api/chats/:id.

import { NextRequest, NextResponse } from "next/server";
import { SqliteChatHistoryStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";

export const runtime = "nodejs";

const store = new SqliteChatHistoryStore();

interface Params {
  params: { id: string; messageId: string };
}

export async function GET(req: NextRequest, { params }: Params) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const html = store.getMessageArtifact(userId, params.id, params.messageId);
  if (html === null) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ html });
}
