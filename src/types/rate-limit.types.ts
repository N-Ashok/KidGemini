// Types for the per-IP rate limiter (docs/SCALABILITY_ISSUES.md #3).
// The decision logic is pure (src/lib/rate-limit.ts); persistence is behind RateLimitStore
// (Dependency Inversion — SQLite now, a shared store when we go multi-instance).

/** Persisted state for one IP. */
export interface IpLimitRecord {
  ip: string;
  /** Start of the current rolling window (ms). */
  windowStart: number;
  /** Requests counted in the current window. */
  count: number;
  /** If > now, the IP is blocked until this time (ms). 0 = not blocked. */
  blockedUntil: number;
  /** How many times this IP has been blocked (persists across days → drives the pay wall). */
  strikes: number;
}

/** Outcome of registering a request. */
export type RateLimitStatus =
  | { state: "ok" }
  | {
      /** Blocked: too many requests. `until` is when it lifts; `mustPay` once strikes hit the cap. */
      state: "blocked";
      until: number;
      mustPay: boolean;
    };

/** Persistence boundary for per-IP limits (concrete impl injected at the edge). */
export interface RateLimitStore {
  /** Register a request from `ip` at `now` (ms) and return whether to allow or block it. */
  hit(ip: string, now: number): RateLimitStatus;
}
