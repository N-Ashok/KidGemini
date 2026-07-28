// POST /api/admin/help — the operator side of the 🆘 queue
// (docs/PRD-COMMUNITY-HELP.md §3.7: kidgemini-local, because the tickets,
// error reports and artifacts all live in kidgemini's SQLite — a cross-repo
// bridge would buy nothing here).
//
// Auth is the SAME shape as /api/usage: ADMIN_SECRET in the POST body (never a
// query param — those land in access logs), timing-safe compare, and unset →
// 503 rather than open. No new credential (PRD §6).
//
// Three actions on one endpoint so the secret check lives in one place:
//   list   — the queue, oldest-first, with waiting state + the canned replies
//            that fit each ticket's reason
//   reply  — send a reply. Canned by default; free text is the marked exception
//            and is screened. Writes EXACTLY ONE ParentAlert so a parent can
//            read every word an adult said to their child (§3.8 constraint 3).
//   source — load the game's HTML. A SEPARATE, audited action: source is never
//            attached to a ticket implicitly (§3.4).

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { SqliteChatHistoryStore, SqliteHelpStore } from "@/lib/db";
import { recordParentAlert } from "@/lib/alerts-sink";
import { cannedById, cannedFor } from "@/lib/help-canned";
import { formatWaiting, ticketAgeState } from "@/lib/help-sla";
import { RulesClassifier } from "@/lib/safety.rules";
import { isGuestAccount, type HelpTicketWithReplies } from "@/types/help.types";

export const runtime = "nodejs";

const help = new SqliteHelpStore();
const chats = new SqliteChatHistoryStore();
const rules = new RulesClassifier();

const MAX_FREE_TEXT_CHARS = 400;

function secretMatches(candidate: string, actual: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function queueRow(t: HelpTicketWithReplies, now: number) {
  return {
    id: t.id,
    accountId: t.accountId,
    isGuest: isGuestAccount(t.accountId),
    reasonCode: t.reasonCode,
    transcript: t.transcript,
    errorReport: t.errorReport,
    verifyVerdict: t.verifyVerdict,
    conversationId: t.conversationId,
    messageId: t.messageId,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    /** Against the 16h target (help-sla.ts) — this is what colours the row. */
    ageState: ticketAgeState(t.createdAt, now),
    waitingLabel: formatWaiting(now - t.createdAt),
    replies: t.replies,
    /** The reviewed replies that fit this reason — canned-first by design. */
    canned: cannedFor(t.reasonCode).map((c) => ({ id: c.id, label: c.label, body: c.body })),
  };
}

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error("[api/admin/help] ADMIN_SECRET is not set — help queue unavailable (fail closed)");
    return NextResponse.json({ error: "admin_unavailable" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.secret !== "string" || !secretMatches(body.secret, adminSecret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const action = typeof body.action === "string" ? body.action : "list";

  if (action === "list") {
    const scope = body.scope === "answered" || body.scope === "all" ? body.scope : "open";
    const tickets = help.listForAdmin(scope, 200).map((t) => queueRow(t, now));
    return NextResponse.json({ tickets, targetHours: 16 });
  }

  const ticketId = typeof body.ticketId === "string" ? body.ticketId : null;
  if (!ticketId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const ticket = help.getById(ticketId);
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (action === "source") {
    // Audited FIRST: the audit row records the intent to look, so a failed or
    // empty fetch is still on the record.
    help.recordAudit(ticketId, "load_source", "admin", now);
    if (!ticket.conversationId) return NextResponse.json({ error: "no_artifact_ref" }, { status: 404 });

    // Read through the owner's own scoped accessor rather than adding an
    // unscoped query — the admin acts on that account's chat, deliberately.
    const convo = chats.get(ticket.accountId, ticket.conversationId);
    if (!convo) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const message =
      convo.messages.find((m) => m.id === ticket.messageId && m.artifactHtml) ??
      [...convo.messages].reverse().find((m) => m.artifactHtml);
    if (!message?.artifactHtml) return NextResponse.json({ error: "no_source" }, { status: 404 });

    return NextResponse.json({ ok: true, title: convo.title, artifactHtml: message.artifactHtml });
  }

  if (action === "reply") {
    const cannedId = typeof body.cannedId === "string" ? body.cannedId : null;
    let replyBody: string;

    if (cannedId) {
      const canned = cannedById(cannedId);
      // A cannedId that isn't in the committed library would claim "reviewed"
      // for text nobody reviewed.
      if (!canned) return NextResponse.json({ error: "unknown_canned" }, { status: 400 });
      if (canned.reasonCode !== ticket.reasonCode) {
        return NextResponse.json({ error: "canned_reason_mismatch" }, { status: 400 });
      }
      replyBody = canned.body;
    } else {
      const typed = typeof body.body === "string" ? body.body.trim() : "";
      if (!typed) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      if (typed.length > MAX_FREE_TEXT_CHARS) {
        return NextResponse.json({ error: "too_long" }, { status: 422 });
      }
      // A guest has no family account, so a free-text reply could not be
      // mirrored to a parent — and an unmirrored adult→child message is exactly
      // what §3.8 constraint 3 forbids. Canned only (PRD §9.1, narrower option).
      if (isGuestAccount(ticket.accountId)) {
        return NextResponse.json({ error: "canned_only_for_guests" }, { status: 403 });
      }
      // Screened with the same deterministic rules the chat input uses. origin
      // "child" is deliberate: it also enables the PII rules, so a helper can
      // never hand a child an email address or phone number, which is the more
      // dangerous failure here than profanity. Guards a typo and a compromised
      // admin session alike.
      const verdict = rules.classifySync({ text: typed, origin: "child" });
      if (verdict.action !== "allow") {
        return NextResponse.json({ error: "reply_blocked", reason: verdict.reason }, { status: 422 });
      }
      replyBody = typed;
    }

    const reply = help.addReply(ticketId, { cannedId, body: replyBody, authorRef: "admin" }, now);
    if (!reply) return NextResponse.json({ error: "not_found" }, { status: 404 });

    // Parent-mirrored, always — one alert per reply, no opt-in, so a parent can
    // read every word any adult said to their child. Guests have no family
    // account to mirror into (their tickets are canned-only above).
    if (!isGuestAccount(ticket.accountId)) {
      recordParentAlert({
        accountId: ticket.accountId,
        // Policy-derived, not a classifier verdict: origin "system" REQUIRES
        // category null and action "allow" (types/alert.types.ts).
        origin: "system",
        category: null,
        severity: "low",
        action: "allow",
        triggerText: `Help ticket · ${ticket.reasonCode}`,
        reason: `A helper at Ariantra replied to your child: "${replyBody}"`,
      });
    }

    return NextResponse.json({ ok: true, replyId: reply.id });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
