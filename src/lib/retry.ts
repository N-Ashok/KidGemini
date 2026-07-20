// Retry transient upstream failures (Gemini 503 "high demand", 429 rate limit, etc.)
// with exponential backoff. Single responsibility: resilience. Server-only.

import "server-only";

/**
 * OUR deadline expired — distinct from an upstream DEADLINE_EXCEEDED.
 *
 * BUG-FIX-LOG 2026-07-20: this used to be a plain Error whose message
 * contained "deadline", which `isRetryable` matched — so a call that blew its
 * budget was retried against the SAME budget, twice, guaranteeing two more
 * full-length waits. A typed error lets us say "not retryable" without
 * changing how a genuine upstream deadline is treated.
 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms (deadline)`);
    this.name = "TimeoutError";
  }
}

/** Status codes / signals worth retrying — transient, not caller error. */
function isRetryable(err: unknown): boolean {
  // Our own budget expiring is deterministic, not transient: an identical call
  // with an identical deadline expires identically. Model DIVERSITY can help
  // here (a different model may be faster) — that is the fallback chain's job,
  // one attempt each — but repeating the same call is pure dead time.
  if (err instanceof TimeoutError || (err as { name?: string } | null)?.name === "TimeoutError") return false;
  const msg = (err as Error)?.message ?? "";
  return (
    /status:\s*(429|500|502|503|504)/.test(msg) ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|deadline/i.test(msg)
  );
}

/** Reject if `fn` doesn't settle within `ms`, so an overloaded model can't hang forever. */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number, label = "upstream"): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) => setTimeout(() => reject(new TimeoutError(label, ms)), ms)),
  ]);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const { retries = 3, baseMs = 400, label = "upstream" } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) throw err;
      const delay = baseMs * 2 ** attempt; // 400ms, 800ms, 1600ms…
      console.warn(`[retry] ${label} attempt ${attempt + 1} failed; retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
