// Pure per-IP rate-limit decision logic (docs/SCALABILITY_ISSUES.md #3). No I/O, no `server-only`
// — the SQLite store (db.ts) loads/saves the record and calls `evaluate`. Kept pure so the policy
// (window reset, block-until-next-day, strike escalation → pay) is exhaustively unit-testable.

import type { IpLimitRecord, RateLimitStatus } from "@/types/rate-limit.types";
import { RATE_LIMIT, type RateLimitConfig } from "./rate-limit.config";

/** Start of the next UTC day (ms) — a block set now lasts until "tomorrow". */
export function startOfNextDay(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0); // rolls into the next day at 00:00:00.000 UTC
  return d.getTime();
}

/**
 * Decide whether a request from an IP is allowed, given its prior record and the current time.
 * Returns the NEW record to persist plus the status to act on. Pure: same inputs → same outputs.
 */
export function evaluate(
  prev: IpLimitRecord | null,
  ip: string,
  now: number,
  cfg: RateLimitConfig = RATE_LIMIT,
): { record: IpLimitRecord; status: RateLimitStatus } {
  const strikes = prev?.strikes ?? 0;

  // Still inside an active block → reject without counting; surface the pay wall once struck out.
  if (prev && prev.blockedUntil > now) {
    return {
      record: prev,
      status: { state: "blocked", until: prev.blockedUntil, mustPay: strikes >= cfg.strikesBeforePay },
    };
  }

  // Window has rolled over (or no prior / block just expired) → start a fresh window.
  let windowStart = prev?.windowStart ?? now;
  let count = prev?.count ?? 0;
  if (now - windowStart >= cfg.windowMs) {
    windowStart = now;
    count = 0;
  }
  count += 1;

  // Over the limit → block until next day, add a strike (strikes persist across days).
  if (count > cfg.maxInWindow) {
    const blockedUntil = startOfNextDay(now);
    const nextStrikes = strikes + 1;
    return {
      record: { ip, windowStart, count, blockedUntil, strikes: nextStrikes },
      status: { state: "blocked", until: blockedUntil, mustPay: nextStrikes >= cfg.strikesBeforePay },
    };
  }

  return {
    record: { ip, windowStart, count, blockedUntil: 0, strikes },
    status: { state: "ok" },
  };
}
