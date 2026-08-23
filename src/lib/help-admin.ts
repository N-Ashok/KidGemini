// The 🆘 help-queue ACTIONS, extracted from /api/admin/help (2026-08-23) so the
// browser route and the server-to-server bridge share ONE implementation.
//
// Why an extraction and not a second copy: this code screens free text, decides
// canned-vs-typed, refuses free text to guests, and mirrors every reply to a
// parent (PRD-COMMUNITY-HELP §3.8 constraint 3). A forked copy is a place for
// exactly one of those to go missing. Both callers do their OWN auth first and
// then hand the parsed body here; this module authenticates nothing.
//
// Returns a plain {status, json} rather than a NextResponse so it stays
// testable and framework-free.

import { SqliteChatHistoryStore, SqliteHelpStore } from "@/lib/db";
import { recordParentAlert } from "@/lib/alerts-sink";
import { cannedById, cannedFor } from "@/lib/help-canned";
import { formatWaiting, ticketAgeState } from "@/lib/help-sla";
import { RulesClassifier } from "@/lib/safety.rules";
import { isGuestAccount, type HelpTicketWithReplies } from "@/types/help.types";

const help = new SqliteHelpStore();
const chats = new SqliteChatHistoryStore();
const rules = new RulesClassifier();

const MAX_FREE_TEXT_CHARS = 400;

export interface HelpActionResult {
  status: number;
  json: unknown;
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

/** Run one help-queue action. The caller has already authenticated. */
export async function handleHelpAction(
  body: Record<string, unknown>,
  now: number,
): Promise<HelpActionResult> {
  const action = typeof body.action === "string" ? body.action : "list";

  if (action === "list") {
    const scope = body.scope === "answered" || body.scope === "all" ? body.scope : "open";
    const tickets = help.listForAdmin(scope, 200).map((t) => queueRow(t, now));
    return { status: 200, json: { tickets, targetHours: 16 } };
  }

  const ticketId = typeof body.ticketId === "string" ? body.ticketId : null;
  if (!ticketId) return { status: 400, json: { error: "bad_request" } };
  const ticket = help.getById(ticketId);
  if (!ticket) return { status: 404, json: { error: "not_found" } };

  if (action === "source") {
    // Audited FIRST: the audit row records the intent to look, so a failed or
    // empty fetch is still on the record.
    help.recordAudit(ticketId, "load_source", "admin", now);
    if (!ticket.conversationId) return { status: 404, json: { error: "no_artifact_ref" } };

    // Read through the owner's own scoped accessor rather than adding an
    // unscoped query — the admin acts on that account's chat, deliberately.
    const convo = chats.get(ticket.accountId, ticket.conversationId);
    if (!convo) return { status: 404, json: { error: "not_found" } };

    const message =
      convo.messages.find((m) => m.id === ticket.messageId && m.artifactHtml) ??
      [...convo.messages].reverse().find((m) => m.artifactHtml);
    if (!message?.artifactHtml) return { status: 404, json: { error: "no_source" } };

    return { status: 200, json: { ok: true, title: convo.title, artifactHtml: message.artifactHtml } };
  }

  if (action === "reply") {
    const cannedId = typeof body.cannedId === "string" ? body.cannedId : null;
    let replyBody: string;

    if (cannedId) {
      const canned = cannedById(cannedId);
      // A cannedId that isn't in the committed library would claim "reviewed"
      // for text nobody reviewed.
      if (!canned) return { status: 400, json: { error: "unknown_canned" } };
      if (canned.reasonCode !== ticket.reasonCode) {
        return { status: 400, json: { error: "canned_reason_mismatch" } };
      }
      replyBody = canned.body;
    } else {
      const typed = typeof body.body === "string" ? body.body.trim() : "";
      if (!typed) return { status: 400, json: { error: "bad_request" } };
      if (typed.length > MAX_FREE_TEXT_CHARS) {
        return { status: 422, json: { error: "too_long" } };
      }
      // A guest has no family account, so a free-text reply could not be
      // mirrored to a parent — and an unmirrored adult→child message is exactly
      // what §3.8 constraint 3 forbids. Canned only (PRD §9.1, narrower option).
      if (isGuestAccount(ticket.accountId)) {
        return { status: 403, json: { error: "canned_only_for_guests" } };
      }
      // Screened with the same deterministic rules the chat input uses. origin
      // "child" is deliberate: it also enables the PII rules, so a helper can
      // never hand a child an email address or phone number, which is the more
      // dangerous failure here than profanity. Guards a typo and a compromised
      // admin session alike.
      const verdict = rules.classifySync({ text: typed, origin: "child" });
      if (verdict.action !== "allow") {
        return { status: 422, json: { error: "reply_blocked", reason: verdict.reason } };
      }
      replyBody = typed;
    }

    const reply = help.addReply(ticketId, { cannedId, body: replyBody, authorRef: "admin" }, now);
    if (!reply) return { status: 404, json: { error: "not_found" } };

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

    return { status: 200, json: { ok: true, replyId: reply.id } };
  }

  return { status: 400, json: { error: "unknown_action" } };
}
