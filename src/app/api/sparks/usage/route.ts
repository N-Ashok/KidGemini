// [api/sparks/usage] Everything the Sparks page shows on the money side
// (docs/2026-08-27_PRD_SparksPage.md §3; owner decision 2026-08-27: EVERYONE
// sees it — revises 2026-07-25's kid-sees-no-deductions rule).
//
// GET            → { balance, used, added, chats: [{ id, title, updatedAt, sparks }] }
//                  ledger numbers from the platform's parent statement (null
//                  when the platform is down — the per-chat list still comes
//                  back); per-chat totals from our own chat store.
// GET ?chat=<id> → { id, asks: [{ ask, sparks, at }] } — what each request in
//                  that chat cost. Never touches the platform.
//
// Identity = the SSO session (same resolver as /api/chats) — guests have no
// Sparks and no account-bound chats. Fail closed: no identity → 401.
import { NextRequest, NextResponse } from "next/server";
import { SqliteChatHistoryStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";
import { SESSION_COOKIE } from "@/lib/ariantra-session";
import { fetchParentStatement } from "@/lib/sparks-bridge";
import { summarizeStatement } from "@/lib/sparks-display";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const store = new SqliteChatHistoryStore();

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const userId = token ? await resolveChatUser(req) : null;
  if (!token || !userId) return NextResponse.json({ error: "signin_required" }, { status: 401 });

  const chat = req.nextUrl.searchParams.get("chat");
  if (chat) return NextResponse.json({ id: chat, asks: store.sparksAsks(userId, chat) });

  const r = await fetchParentStatement(token);
  const ledger = r.status === 200 ? summarizeStatement(r.data) : { balance: null, used: null, added: null };
  return NextResponse.json({ ...ledger, chats: store.sparksByConversation(userId) });
}
