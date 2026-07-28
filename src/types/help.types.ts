// Community Help Phase 1 (docs/PRD-COMMUNITY-HELP.md): a stuck child asks a
// real person for help, an admin answers from a queue, and the reply is
// one-way and mirrored to the parent.
//
// Identity note: `accountId` holds the SAME string chat-identity.ts's
// resolveChatUser() returns and alerts.accountId already stores —
// `user:<email>` when signed in, `guest:<uuid>` otherwise. One column covers
// both because the parent mirror keys off exactly that value; guest-ness is
// the `guest:` prefix (isGuestAccount below), not a second column.
//
// PRD §3.5 also proposed ownerType/ownerId mirroring a per-child scoping phase
// that has NOT shipped (no getActiveChildId anywhere in the tree as of
// 2026-07-28), so those columns are deliberately absent: when child scoping
// lands, help_tickets takes the same PRAGMA-guarded ALTER as alerts will.

/** The picture reasons on the 🆘 sheet. Structured codes — never free prose —
 *  because the histogram drives the Phase 2 gallery backlog and any future
 *  public Q&A corpus (PRD §5.3). */
export type HelpReasonCode =
  | "wont_move"
  | "blank"
  | "looks_wrong"
  | "no_sound"
  | "dont_know"
  | "other";

export const HELP_REASON_CODES: readonly HelpReasonCode[] = [
  "wont_move",
  "blank",
  "looks_wrong",
  "no_sound",
  "dont_know",
  "other",
] as const;

export function isHelpReasonCode(value: unknown): value is HelpReasonCode {
  return typeof value === "string" && (HELP_REASON_CODES as readonly string[]).includes(value);
}

/** `open` = waiting on a human · `answered` = a reply exists, kid hasn't judged
 *  it · `closed` = the kid tapped 👍 That helped. 😕 Still stuck moves an
 *  answered ticket back to `open` (PRD §3.8 constraint 2 — reopening never
 *  carries new text). */
export type HelpTicketStatus = "open" | "answered" | "closed";

export interface HelpTicket {
  id: string;
  accountId: string;
  reasonCode: HelpReasonCode;
  /** The kid's own words, only when they used 🎤 Something else. */
  transcript: string | null;
  /** buildErrorReport() output — bounded, and by construction free of game
   *  source (src/lib/error-report.ts). Pruned on close + PRUNE_TEXT_AFTER_MS. */
  errorReport: string | null;
  /** The verify verdict/classification code the admin would otherwise ask for. */
  verifyVerdict: string | null;
  /** An artifact REFERENCE, not the artifact: which chat and which message. */
  conversationId: string | null;
  messageId: string | null;
  status: HelpTicketStatus;
  createdAt: number;
  updatedAt: number;
}

export interface HelpReply {
  id: string;
  ticketId: string;
  /** Non-null = a reply from the committed library (help-canned.ts), which
   *  needs no review. Null = free text, flagged as the exception in the queue. */
  cannedId: string | null;
  body: string;
  /** Which admin identity answered. Never shown to the child — the card always
   *  reads "A helper at Ariantra" (PRD §3.8 constraint 4). */
  authorRef: string;
  createdAt: number;
}

export interface HelpTicketWithReplies extends HelpTicket {
  replies: HelpReply[];
}

/** What POST /api/help accepts. No `accountId` — identity is resolved
 *  server-side, never taken from the client. */
export interface NewHelpTicket {
  reasonCode: HelpReasonCode;
  transcript?: string | null;
  errorReport?: string | null;
  verifyVerdict?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
}

export type HelpCreateResult =
  /** `deduped` = an identical ask inside DEDUPE_WINDOW_MS returned the EXISTING
   *  ticket instead of a second row (PRD §3.6) — the kid sees success either
   *  way, which is why this is not an error. */
  | { ok: true; ticket: HelpTicket; deduped: boolean }
  | { ok: false; reason: "too_many_open" };

/** True for a device-cookie identity with no family account behind it. Guests
 *  can file tickets (the guest wall must not block asking for help) but get
 *  canned replies only, because there is no parent to mirror a free-text
 *  reply to (PRD §9.1, narrower option chosen). */
export function isGuestAccount(accountId: string): boolean {
  return accountId.startsWith("guest:");
}

/** Persistence boundary — the concrete SQLite impl is injected at the edge. */
export interface HelpStore {
  create(accountId: string, input: NewHelpTicket, now: number): HelpCreateResult;
  /** The caller's OWN tickets, newest first. Never takes an id from the client
   *  as authorisation. */
  listOwn(accountId: string, limit?: number): HelpTicketWithReplies[];
  /** Operator lookup by id — UNSCOPED, so it must only be reached through the
   *  ADMIN_SECRET gate. Null when unknown. */
  getById(ticketId: string): HelpTicketWithReplies | null;
  /** Operator view. `open` also includes `answered` rows the kid hasn't judged
   *  yet; oldest first, because newest-first buries the ticket that waited all
   *  night (see help-sla.ts). */
  listForAdmin(scope: "open" | "answered" | "all", limit?: number): HelpTicketWithReplies[];
  /** One reply row + the ticket moving to `answered`. Null when the ticket is
   *  unknown, so a caller can 404 instead of silently succeeding. */
  addReply(
    ticketId: string,
    reply: { cannedId: string | null; body: string; authorRef: string },
    now: number,
  ): HelpReply | null;
  /** 👍 / 😕 from the kid. Scoped to the owner: false when the ticket is
   *  unknown OR belongs to another identity (fail closed). */
  judgeOwn(accountId: string, ticketId: string, helped: boolean, now: number): boolean;
  /** Loading a game's source is a SEPARATE, explicitly logged admin action —
   *  source is never attached to a ticket implicitly (PRD §3.4/§3.7). */
  recordAudit(ticketId: string, action: string, authorRef: string, now: number): void;
  auditFor(ticketId: string): HelpAuditEntry[];
  /** Retention (PRD §7): drop the free text on tickets closed longer than
   *  PRUNE_TEXT_AFTER_MS ago, keeping the structured row. Returns rows pruned. */
  pruneClosedText(now: number): number;
}

export interface HelpAuditEntry {
  id: string;
  ticketId: string;
  action: string;
  authorRef: string;
  createdAt: number;
}
