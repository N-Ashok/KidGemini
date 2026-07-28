// The kid side of Community Help, as pure functions (docs/PRD-COMMUNITY-HELP.md).
//
// WHY this is server-derived: a reply can take up to 16 hours (help-sla.ts), so
// the child is almost never on screen when it lands. The waiting strip and the
// 📬 badge are therefore computed from GET /api/help on every boot, not from
// any in-memory flag — an in-memory flag would silently lose the ticket across
// a reload, the same class of bug as the leave-and-come-back reply loss
// (BUG-FIX-LOG 2026-07-28).
//
// Storage-injected and never-throwing, same contract as idea-coach.ts.

import type { HelpReasonCode, HelpTicketStatus } from "@/types/help.types";

/** Gates the 🆘 tab, the sheet and every help affordance. Default OFF: once a
 *  child can ask a person for help, someone has to be there (PRD §8 step 3). */
export function helpButtonEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PUBLIC_ENABLE_HELP_BUTTON === "1";
}

/** Gates the PROACTIVE nudge only — separately flagged because it's the change
 *  most likely to spike volume onto one admin (PRD §8 step 4). Requires the
 *  button flag too: nudging toward an affordance that isn't rendered would be a
 *  dead end. */
export function helpNudgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return helpButtonEnabled(env) && env.NEXT_PUBLIC_ENABLE_HELP_NUDGE === "1";
}

export interface HelpReplyView {
  id: string;
  body: string;
  createdAt: number;
  /** From the reviewed library vs hand-written. Not surfaced to the child —
   *  kept because the parent view distinguishes them. */
  canned: boolean;
}

/** Exactly what GET /api/help returns for the child (authorRef never included). */
export interface HelpTicketView {
  id: string;
  reasonCode: HelpReasonCode;
  status: HelpTicketStatus;
  conversationId: string | null;
  messageId: string | null;
  createdAt: number;
  updatedAt: number;
  replies: HelpReplyView[];
}

export interface HelpView {
  /** Still with a helper — the "⏳ nothing for you to do" strip. */
  waiting: HelpTicketView[];
  /** Answered and not yet judged 👍/😕 — the reply card is readable. */
  answered: HelpTicketView[];
  /** Answered tickets whose reply the child has not been shown yet: the 📬 badge. */
  unreadCount: number;
}

export function deriveHelpView(tickets: HelpTicketView[], seenReplyIds: string[]): HelpView {
  const seen = new Set(seenReplyIds);
  const waiting = tickets.filter((t) => t.status === "open");
  const answered = tickets.filter((t) => t.status === "answered");
  const unreadCount = answered.filter((t) => t.replies.some((r) => !seen.has(r.id))).length;
  return { waiting, answered, unreadCount };
}

/** The ticket that belongs to the chat currently on screen. Help state is
 *  per-chat: a ticket filed about the dino game must not annotate the turtle
 *  game's thread. */
export function ticketForConversation(
  tickets: HelpTicketView[],
  conversationId: string | null,
): HelpTicketView | null {
  if (!conversationId) return null;
  return tickets.find((t) => t.conversationId === conversationId) ?? null;
}

const SEEN_KEY = "kidgemini:help-seen:v1";
/** Enough to cover any realistic backlog without growing forever. */
const MAX_SEEN = 50;

export function loadSeenReplies(storage: Storage): string[] {
  try {
    const raw = storage.getItem(SEEN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // Fail OPEN: the worst case is the 📬 badge showing once more, which is
    // strictly better than hiding an answer a child is waiting for.
    return [];
  }
}

export function markRepliesSeen(storage: Storage, ids: string[]): void {
  try {
    const merged = Array.from(new Set([...loadSeenReplies(storage), ...ids]));
    storage.setItem(SEEN_KEY, JSON.stringify(merged.slice(-MAX_SEEN)));
  } catch {
    /* quota/private mode — the badge may reappear, nothing breaks */
  }
}

const HOUR = 60 * 60 * 1000;

/** How long ago they asked, in words a 7-year-old reads. Never an hour count:
 *  "16 hours" means nothing at that age, "yesterday" does. */
export function sentAgoLabel(createdAt: number, now: number): string {
  const ago = Math.max(0, now - createdAt);
  if (ago < HOUR) return "sent just now";
  if (ago < 12 * HOUR) return "sent today";
  if (ago < 48 * HOUR) return "sent yesterday";
  return "sent a few days ago";
}
