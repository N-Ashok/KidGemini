// POST /api/help — a child files a 🆘 ticket for a real person.
// GET  /api/help — that child's own tickets + any replies.
//
// docs/PRD-COMMUNITY-HELP.md Phase 1. Three properties this route exists to
// hold, all pinned in route.test.ts:
//
//  1. Identity is resolved SERVER-side (resolveChatUser, the same key
//     usage_events and alerts use) and an accountId in the body is ignored.
//     Guests may file — the guest wall must not block asking for help.
//  2. A ticket never carries the generated game. The client sends
//     buildErrorReport() output, which excludes source by construction; this
//     route refuses anything that looks like a document anyway rather than
//     trusting the client (defence in depth, same spirit as
//     MAX_SELF_HARM_SCAN_CHARS in safety.rules.ts).
//  3. The child never learns which admin answered — authorRef is stripped on
//     the way out, so the card can only ever read "A helper at Ariantra".

import { NextRequest, NextResponse } from "next/server";
import { SqliteHelpStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";
import { isHelpReasonCode, type HelpTicketWithReplies } from "@/types/help.types";

export const runtime = "nodejs";

const help = new SqliteHelpStore();

/** Cheap "this is a game, not an error note" test. The client already sends the
 *  bounded report, so anything document-shaped here is a bug or an attempt. */
function looksLikeSource(text: string | null | undefined): boolean {
  if (!text) return false;
  return /<!doctype html|<html[\s>]|<script[\s>]|<canvas[\s>]/i.test(text);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** What the CHILD is allowed to see: the reply text and when it landed, never
 *  who wrote it (PRD §3.8 constraint 4 — the card says "a helper at Ariantra"
 *  and the UI teaches the difference between Ari, a helper and a stranger). */
function forChild(t: HelpTicketWithReplies) {
  return {
    id: t.id,
    reasonCode: t.reasonCode,
    status: t.status,
    conversationId: t.conversationId,
    messageId: t.messageId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    replies: t.replies.map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.createdAt,
      /** True = came from the reviewed library; the child sees no id either way. */
      canned: r.cannedId !== null,
    })),
  };
}

export async function POST(req: NextRequest) {
  const accountId = await resolveChatUser(req);
  if (!accountId) {
    // No session and no device cookie: nothing to attribute a ticket to, and
    // nowhere to deliver the answer.
    return NextResponse.json(
      { error: "no_identity", message: "Send Ari a message first, then I can pass this on." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isHelpReasonCode(body.reasonCode)) {
    return NextResponse.json({ error: "bad_reason" }, { status: 400 });
  }

  const transcript = str(body.transcript);
  const errorReport = str(body.errorReport);
  if (looksLikeSource(errorReport) || looksLikeSource(transcript)) {
    return NextResponse.json(
      { error: "source_not_accepted", message: "Send the error notes, not the game itself." },
      { status: 422 },
    );
  }

  const result = help.create(
    accountId,
    {
      reasonCode: body.reasonCode,
      transcript,
      errorReport,
      verifyVerdict: str(body.verifyVerdict),
      conversationId: str(body.conversationId),
      messageId: str(body.messageId),
    },
    Date.now(),
  );

  if (!result.ok) {
    // Not a dead end (CLAUDE.md §9): say what's happening and what frees a slot.
    return NextResponse.json(
      {
        error: "too_many_open",
        message: "A helper is already looking at your other games! Tap 👍 on their answer and you can ask again.",
      },
      { status: 429 },
    );
  }

  return NextResponse.json({
    ok: true,
    ticketId: result.ticket.id,
    status: result.ticket.status,
    createdAt: result.ticket.createdAt,
    /** The dedupe window returned the ticket they already had — success either
     *  way, so the UI shows the same confirmation. */
    alreadyOpen: result.deduped,
  });
}

export async function GET(req: NextRequest) {
  const accountId = await resolveChatUser(req);
  // A brand-new visitor has no tickets rather than an error — the client polls
  // this on boot to rebuild the waiting/📬 state.
  if (!accountId) return NextResponse.json({ tickets: [] });
  return NextResponse.json({ tickets: help.listOwn(accountId).map(forChild) });
}
