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
  kind: "chat" | "safety";
  promptTokens: number;
  outputTokens: number;
  /** Estimated USD cost for this single call. */
  costUsd: number;
  geo: GeoInfo;
  /** The request text and the produced output (parent/admin visible only). */
  requestText: string;
  outputText: string;
  blocked: boolean;
}

/** Aggregations the dashboard renders. */
export interface UsageSummary {
  totalPromptTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  eventCount: number;
  /** Per-UTC-day totals, newest first — the admin "per day / top spender" view. */
  byDay: Array<{
    day: string; // YYYY-MM-DD (UTC)
    promptTokens: number;
    outputTokens: number;
    costUsd: number;
    eventCount: number;
    topUser: { userId: string; userLabel: string | null; tokens: number } | null;
  }>;
  byUser: Array<{
    userId: string;
    userLabel: string | null;
    promptTokens: number;
    outputTokens: number;
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
  /**
   * Total tokens (promptTokens + outputTokens, across every `kind` including safety)
   * ever attributed to a user. Powers the server-enforced guest gate.
   */
  tokensUsedByUser(userId: string, sinceMs?: number): number;
  /** Guest tokens spent from an IP across ALL guest cookies — the cookie-clearing backstop. */
  guestTokensUsedByIp(ip: string, sinceMs?: number): number;
  /** Tokens attributed to a user since a timestamp — powers the signed-in daily budget. */
  tokensUsedByUserSince(userId: string, sinceMs: number): number;
}
