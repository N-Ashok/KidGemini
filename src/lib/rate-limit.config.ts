// Per-IP rate limiting for /api/chat — abuse / Gemini-cost control (docs/SCALABILITY_ISSUES.md #3).
// Tunables only (Open/Closed). Guests are limited; signed-in users are exempt (set at the call site).

export const RATE_LIMIT = {
  /** Rolling window length. */
  windowMs: 5 * 60_000, // 5 minutes
  /** Max requests allowed per IP within the window before a block. */
  maxInWindow: 30,
  /** After this many blocks (across days), the IP is pushed to pay instead of just waiting. */
  strikesBeforePay: 3,
} as const;

export type RateLimitConfig = typeof RATE_LIMIT;
