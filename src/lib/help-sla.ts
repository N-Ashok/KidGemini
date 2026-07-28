// The reply target for a help ticket (docs/PRD-COMMUNITY-HELP.md; owner call
// 2026-07-28: "the reply is not immediate, it can be within 16 hours").
//
// One constant, two consumers: the kid-facing copy promises "by tomorrow"
// (chat-copy.ts) and the admin queue colours waiting time against the same
// number — so the promise and the dashboard can't drift apart. 16 hours from
// any waking hour lands inside the next day, which is why "by tomorrow" is the
// one phrasing that always holds; "16 hours" is meaningless to a 7-year-old.

export const HELP_REPLY_TARGET_HOURS = 16;
export const HELP_REPLY_TARGET_MS = HELP_REPLY_TARGET_HOURS * 60 * 60 * 1000;

/** Half the target: still time to answer inside the promise. */
export const HELP_DUE_SOON_MS = HELP_REPLY_TARGET_MS / 2;

export type TicketAgeState = "fresh" | "due" | "overdue";

/** How a waiting ticket reads in the queue. `overdue` means the promise the
 *  child was given is now broken — nothing auto-answers on that (PRD §9.4);
 *  the honest lever is narrowing the nudge (stuck-signal.ts). */
export function ticketAgeState(createdAt: number, now: number): TicketAgeState {
  // Clock skew (a client-stamped createdAt, a server clock jump) must never
  // read as overdue — fail toward "no alarm."
  const waited = Math.max(0, now - createdAt);
  if (waited >= HELP_REPLY_TARGET_MS) return "overdue";
  if (waited >= HELP_DUE_SOON_MS) return "due";
  return "fresh";
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact waiting time for the operator queue: "12m", "15h 40m", "2d 2h". */
export function formatWaiting(ms: number): string {
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}
