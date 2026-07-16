// PRD-SCREEN-TIME-CAP-MVP Part B — pure minute-derivation policy. No DB/React
// imports. Minutes are derived from `screen_time_pings` timestamps (see
// db.ts): a chat completion records one, and — since 2026-07-15, so that
// playing an already-built game counts too, not just typing to the bot —
// a lightweight client heartbeat (ScreenTimeHeartbeat.tsx) pings while the
// tab is open and visible, whether the kid is chatting or playing.

/** A gap this long or longer between two pings means the kid left — only
 *  this much of the gap counts, not the full elapsed time. Comfortably
 *  above HEARTBEAT_INTERVAL_MS so one or two missed ticks don't lose time. */
export const GAP_CAP_MINUTES = 5;
/** Flat allowance after the LAST ping of the window — still reading or
 *  playing, not mid-gap. */
export const TAIL_MINUTES = 2;
/** Client heartbeat cadence (ScreenTimeHeartbeat.tsx) — how often to ping
 *  while the tab is visible. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** UTC-midnight boundary for `nowMs`'s day — mirrors the boundary
 *  `chat/route.ts` already uses for `signedInDailyTokenLimit`. */
export function utcDayStart(nowMs: number): number {
  return new Date(nowMs).setUTCHours(0, 0, 0, 0);
}

/** Sums gaps between consecutive ascending timestamps (each capped at
 *  GAP_CAP_MINUTES) plus a flat TAIL_MINUTES after the last event. Accepted
 *  trade-off: a kid silently playing a generated game without sending chat
 *  messages is undercounted — fine for an alert, not a lock. */
export function deriveActiveMinutes(timestampsAsc: number[]): number {
  const [first, ...rest] = timestampsAsc;
  if (first === undefined) return 0;
  const gapCapMs = GAP_CAP_MINUTES * 60_000;
  let ms = 0;
  let prev = first;
  for (const t of rest) {
    ms += Math.min(t - prev, gapCapMs);
    prev = t;
  }
  ms += TAIL_MINUTES * 60_000;
  return Math.round(ms / 60_000);
}
