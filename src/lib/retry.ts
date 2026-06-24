// Retry transient upstream failures (Gemini 503 "high demand", 429 rate limit, etc.)
// with exponential backoff. Single responsibility: resilience. Server-only.

import "server-only";

/** Status codes / signals worth retrying — transient, not caller error. */
function isRetryable(err: unknown): boolean {
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
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (deadline)`)), ms),
    ),
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
