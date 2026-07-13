// Client half of resumable generations (TECH_DEBT #23): after a dropped or
// stalled stream, poll /api/chat/result before re-generating. Under heavy
// model load this is the whole tactic — the server keeps generating while
// we're detached, so patience is free; a re-generation is paid AND re-enters
// the same overloaded pool. Injectable fetch/sleep for tests.

export interface ResumedTurn {
  text: string;
  artifactHtml: string | null;
}

/** How long to keep polling while the server still says `running`. Generous
 *  on purpose: builder turns think for minutes under load, and waiting is
 *  free while re-generating costs tokens. */
export const RESUME_MAX_MS = 240_000;
export const RESUME_INTERVAL_MS = 4_000;

/**
 * Poll for a turn's server-side result.
 *  - `done`   → the finished reply (apply it, no re-generation).
 *  - `error`, 404, or `running` past the budget → null (caller re-generates).
 * Any network failure while polling counts as a miss for that tick, not a
 * verdict — the loop keeps going until the budget runs out.
 */
export async function pollTurnResult(
  replyId: string,
  opts: {
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    maxMs?: number;
    intervalMs?: number;
  } = {},
): Promise<ResumedTurn | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxMs = opts.maxMs ?? RESUME_MAX_MS;
  const intervalMs = opts.intervalMs ?? RESUME_INTERVAL_MS;

  for (let waited = 0; ; waited += intervalMs) {
    try {
      const res = await fetchFn(`/api/chat/result?replyId=${encodeURIComponent(replyId)}`, { cache: "no-store" });
      if (res.status === 404) return null; // unknown turn (old server / never started) — re-generate
      if (res.ok) {
        const body = (await res.json()) as { status: string; text?: string; artifactHtml?: string | null };
        if (body.status === "done") return { text: body.text ?? "", artifactHtml: body.artifactHtml ?? null };
        if (body.status === "error") return null; // server-side failure — re-generate
        // `running` → fall through and keep waiting
      }
    } catch {
      /* offline tick — keep polling until the budget runs out */
    }
    if (waited + intervalMs > maxMs) return null;
    await sleep(intervalMs);
  }
}
