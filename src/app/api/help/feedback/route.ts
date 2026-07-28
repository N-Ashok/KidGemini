// POST /api/help/feedback — the child's verdict on a helper's reply:
// 👍 That helped (closes) or 😕 Still stuck (reopens).
//
// This is the ONLY thing a child can send back, and it carries no text
// (docs/PRD-COMMUNITY-HELP.md §3.8 constraint 2 — one-way by construction, so
// no open channel to an adult is ever created). Any extra fields in the body
// are ignored on purpose: a `note` a client might add must not become a message.

import { NextRequest, NextResponse } from "next/server";
import { SqliteHelpStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";

export const runtime = "nodejs";

const help = new SqliteHelpStore();

export async function POST(req: NextRequest) {
  const accountId = await resolveChatUser(req);
  if (!accountId) return NextResponse.json({ error: "no_identity" }, { status: 401 });

  let body: { ticketId?: unknown; helped?: unknown };
  try {
    body = (await req.json()) as { ticketId?: unknown; helped?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const ticketId = typeof body.ticketId === "string" ? body.ticketId : null;
  if (!ticketId || typeof body.helped !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Scoped write: an unknown ticket and another child's ticket are the same
  // answer, so a valid id from elsewhere reveals nothing (fail closed).
  const ok = help.judgeOwn(accountId, ticketId, body.helped, Date.now());
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ ok: true, status: body.helped ? "closed" : "open" });
}
