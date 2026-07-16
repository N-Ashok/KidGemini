// Daily screen-time cap (PRD-SCREEN-TIME-CAP-MVP Part B). Keyed by the SSO
// userId — same identity parent_auth already uses (one account per family,
// see the PRD's Context section for why this isn't a separate child entity).
// Types first; routes depend on the interfaces, never on better-sqlite3
// directly.

export interface ScreenTimeSettings {
  /** SSO userId ("user:<email>") — the family account key. */
  accountId: string;
  /** null = no cap set (feature off for this family). */
  dailyCapMinutes: number | null;
  updatedAt: number;
}

/** One row per (account, UTC calendar day). */
export interface ScreenTimeDaily {
  accountId: string;
  /** UTC midnight, epoch ms — see `utcDayStart()` in `screen-time.ts`. */
  dayStart: number;
  activeMinutes: number;
  /** ms epoch the cap-crossed alert fired, or null — debounces to exactly
   *  one alert per account per day. */
  alertedAt: number | null;
  updatedAt: number;
}

export interface ScreenTimeStore {
  getSettings(accountId: string): ScreenTimeSettings | null;
  /** Insert or replace the cap (set/clear). */
  putSettings(accountId: string, dailyCapMinutes: number | null): ScreenTimeSettings;
  getToday(accountId: string, dayStart: number): ScreenTimeDaily | null;
  /** Record one presence timestamp — a chat completion or a client
   *  heartbeat tick (ScreenTimeHeartbeat.tsx, while the tab is open and
   *  visible). The sole source `recomputeAndMaybeAlert` derives minutes
   *  from. Also prunes pings past the retention window. */
  recordPing(accountId: string, nowMs: number): void;
  /** Recompute today's tally from recorded pings, upsert it, and — if a cap
   *  is set, just crossed, and not yet alerted today — record exactly one
   *  ParentAlert and stamp alertedAt. Fail-open at the CALL SITE, not here. */
  recomputeAndMaybeAlert(accountId: string, userLabel: string | null, nowMs: number): void;
}
