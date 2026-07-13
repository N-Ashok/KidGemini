// Server-side chat history (TECH_DEBT #26).
// GET  /api/chats?before=<updatedAt>&limit=N → { chats: ConvoSummary[] } —
//      the sidebar's paginated Recents index (titles only, no payloads).
// POST /api/chats { convos: Conversation[] } → one-time device migration
//      (bulk upsert, idempotent). Identity = SSO session or guest cookie;
//      no identity → empty list / 401 on write (fail closed).

import { NextRequest, NextResponse } from "next/server";
import { SqliteChatHistoryStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";
import { sanitizeConversation, LIST_DEFAULT, LIST_MAX, MAX_BULK } from "@/lib/chat-history";
import type { Conversation } from "@/types/chat.types";

export const runtime = "nodejs";

const store = new SqliteChatHistoryStore();

export async function GET(req: NextRequest) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ chats: [] });
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
