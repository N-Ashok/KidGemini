// Usage / analytics types — power the admin dashboard (token usage, cost, geo, per-user).

export interface GeoInfo {
  ip: string | null;
  country: string | null;
  region: string | null; // state/province
  city: string | null;
}

export interface UsageEvent {
  id: string;
  createdAt: number;
  /** Stable per-user identifier (child profile / device). */
  userId: string;
  userLabel: string | null; // friendly name shown in the dashboard
  model: string;
  /** "repair" = self-healing preview fix call — recorded for cost visibility
   *  but EXEMPT from the guest/daily token gates (PRD §12 decision).
   *  "fallback" = a LOSING/superseded model call from a fan-out (a one-shot
   *  backup that finished after the winner, owner ask 2026-07-21). We still
   *  paid for it, so it's recorded and COUNTED IN THE DASHBOARD COST — but,
   *  like repair, EXEMPT from the child's quota (our race waste isn't their
   *  spend). Carries the loser's model + real billed usage. */
  kind: "chat" | "safety" | "repair" | "fallback";
  /** CHAR-ESTIMATE of the visible request text. The guest/daily gates are
   *  tuned to these two estimate fields — billed* below carry the real counts. */
  promptTokens: number;
  outputTokens: number;
  /** REAL billed counts from Gemini usageMetadata (2026-07-14). Optional on
   *  record(): when absent (stream died before usageMetadata, safety calls)
   *  billed* falls back to the estimates and thought/cached to 0. billedPrompt
   *  INCLUDES cached (Gemini reports cache hits as a subset of prompt). */
  billedPromptTokens?: number;
  billedOutputTokens?: number;
  thoughtTokens?: number;
  cachedTokens?: number;
  /** Estimated USD cost for this single call. */
  costUsd: number;
  /** Raw User-Agent header (2026-07-14) — splits devices behind one IP
   *  ("Chrome on Windows" vs "Safari on iPad"). Standard header, no
   *  fingerprinting. Null on legacy rows / headerless clients. */
  userAgent?: string | null;
  geo: GeoInfo;
  /** The request text and the produced output (parent/admin visible only). */
  requestText: string;
  outputText: string;
  blocked: boolean;
}

/** One rollup window (today / this week / …): the 4 billed token types +
 *  request count + cost. ₹ is derived in the route (costUsd × inrPerUsd). */
export interface PeriodTotals {
  eventCount: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/** Distinct-visitor counts for one window. Three signals, none perfect alone:
 *  signedInUsers = distinct accounts (multi-device person = 1);
 *  guestBrowsers = distinct guest cookies (per browser; cookie clears inflate);
 *  guestDevices  = distinct guest (ip, userAgent) pairs (dedupes re-minted
 *  cookies on one machine; shared wifi + same browser can undercount). */
export interface UniqueCounts {
  signedInUsers: number;
  guestBrowsers: number;
  guestDevices: number;
}

/** A user (account or guest cookie) active on 2+ distinct IST days — the
 *  "who keeps coming back" list. Same-day repeats are engagement, not a return. */
export interface RepeatUser {
  userId: string;
  userLabel: string | null;
  activeDays: number;
  eventCount: number;
  firstSeen: number;
  lastSeen: number;
}

/** Aggregations the dashboard renders. Token fields here are the BILLED
 *  counts (real Gemini usageMetadata; legacy rows fall back to estimates). */
export interface UsageSummary {
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalThoughtTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  eventCount: number;
  /** Per-UTC-day totals, newest first — the admin "per day / top spender" view. */
  byDay: Array<{
    day: string; // YYYY-MM-DD (UTC)
    promptTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    cachedTokens: number;
    costUsd: number;
    eventCount: number;
    topUser: { userId: string; userLabel: string | null; tokens: number } | null;
  }>;
  byUser: Array<{
    userId: string;
    userLabel: string | null;
    promptTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    cachedTokens: number;
    costUsd: number;
    eventCount: number;
  }>;
  byLocation: Array<{
    country: string | null;
    region: string | null;
    city: string | null;
    eventCount: number;
    costUsd: number;
  }>;
}

/** Persistence boundary for usage events (concrete impl injected at the edge). */
export interface UsageStore {
  record(event: Omit<UsageEvent, "id" | "createdAt">): UsageEvent;
  /** Events within [sinceMs, nowMs]. */
  listSince(sinceMs: number): UsageEvent[];
  summarizeSince(sinceMs: number): UsageSummary;
  /** Billed-token + cost totals within [sinceMs, now] — one cheap SQL SUM,
   *  powers the today/week/month/year rollup cards. */
  totalsSince(sinceMs: number): PeriodTotals;
  /** Distinct-visitor counts within [sinceMs, now] — the "unique users" panel. */
  uniquesSince(sinceMs: number): UniqueCounts;
  /** Users active on 2+ distinct IST days within [sinceMs, now], most days first. */
  repeatUsersSince(sinceMs: number): RepeatUser[];
  /**
   * Total tokens (promptTokens + outputTokens, across every gated `kind` —
   * chat + safety; kind:"repair" is exempt) ever attributed to a user.
   * Powers the server-enforced guest gate.
   */
  tokensUsedByUser(userId: string, sinceMs?: number): number;
  /** Guest tokens spent from an IP across ALL guest cookies — the cookie-clearing backstop. */
  guestTokensUsedByIp(ip: string, sinceMs?: number): number;
  /** Tokens attributed to a user since a timestamp — powers the signed-in daily budget. */
  tokensUsedByUserSince(userId: string, sinceMs: number): number;
}
