// Community Help policy numbers, in one place so they can be tuned without
// touching logic (docs/PRD-COMMUNITY-HELP.md §3.6, §7). Same spirit as
// gate.config.ts / billing.config.ts.

/** At most this many tickets waiting on a human per identity. A child who taps
 *  🆘 four times has a bigger problem than four tickets can express, and one
 *  admin answering is the real ceiling (PRD §9.4). */
export const MAX_OPEN_TICKETS = 3;

/** Two identical taps (same game message + same reason) inside this window are
 *  ONE ticket — the second returns the first's id rather than an error, because
 *  a kid re-tapping out of doubt should never see a failure. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Retention (PRD §7): once a ticket is closed, its free text (errorReport,
 *  transcript) is dropped this long after, keeping the structured row. The
 *  analytics value is in the reason codes and timings, not the text — so the
 *  text can go early without losing anything. */
export const PRUNE_TEXT_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Defensive ceiling on anything a client sends us. errorReport is already
 *  bounded by MAX_REPORT_CHARS on the client; this is the server not trusting
 *  that, in the same spirit as MAX_SELF_HARM_SCAN_CHARS in safety.rules.ts. */
export const MAX_TRANSCRIPT_CHARS = 1_000;
export const MAX_VERDICT_CHARS = 200;
