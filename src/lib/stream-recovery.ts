// Decides whether a dropped /api/chat stream is retried automatically.
// Pure so it unit-tests plain (the retry loop itself lives in the container).
// Class: mobile socket drops mid-stream — see BUG-FIX-LOG 2026-07-09.

// Small on purpose: every retry re-runs the whole generation (paid tokens).
export const STREAM_RETRY_LIMIT = 2;

export function shouldAutoRetry(opts: {
  manualStop: boolean;
  finalized: boolean;
  attempt: number;
}): boolean {
  if (opts.manualStop || opts.finalized) return false;
  return opts.attempt < STREAM_RETRY_LIMIT;
}
