// GET /api/chat/result?replyId=… — resumable generations (TECH_DEBT #23).
// A client that lost its stream (screen lock, stall-guard abort under heavy
// load) polls here: `running` → keep waiting, `done` → apply the finished
// reply (no re-generation, no extra cost), `error`/404 → re-generate.
// Ownership fail-closed: the row must belong to this request's identity.

import { NextRequest, NextResponse } from "next/server";
import { SqliteTurnResultStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";

export const runtime = "nodejs";

const turnResults = new SqliteTurnResultStore();

export async function GET(req: NextRequest) {
  const userId = await resolveChatUser(req);
  const replyId = req.nextUrl.searchParams.get("replyId");
  if (!userId || !replyId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const result = turnResults.get(userId, replyId);
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(result);
}
