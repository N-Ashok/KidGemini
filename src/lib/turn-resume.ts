// Client half of resumable generations (TECH_DEBT #23): after a dropped or
// stalled stream, poll /api/chat/result before re-generating. Under heavy
// model load this is the whole tactic — the server keeps generating while
// we're detached, so patience is free; a re-generation is paid AND re-enters
// the same overloaded pool. Injectable fetch/sleep for tests.

export interface ResumedTurn {
  text: string;
  artifactHtml: string | null;
}

/** What the poll actually learned. `pollTurnResult` flattens this to
 *  reply-or-null, which is right for the LIVE retry path (it re-generates on
 *  anything else) but WRONG for tab-close recovery: "still running" and "gone"
 *  need opposite treatment there — one must keep the recovery bookmark for the
 *  next app load, the other must drop it. See BUG-FIX-LOG 2026-07-28. */
export type TurnOutcome =
  | ({ status: "done" } & ResumedTurn)
  /** The server is STILL generating; we ran out of poll budget, not hope. */
  | { status: "running" }
  /** Server-side failure — nothing will ever arrive. */
  | { status: "error" }
  /** 404 / never reachable: no such turn on this server, for this identity. */
  | { status: "unknown" };

/** How long to keep polling while the server still says `running`. Generous
 *  on purpose: builder turns think for minutes under load, and waiting is
 *  free while re-generating costs tokens. */
export const RESUME_MAX_MS = 240_000;
export const RESUME_INTERVAL_MS = 4_000;

/** Dead-server fail-fast budget (BUG-FIX-LOG 2026-07-18): the heavy-load
 *  patience above only pays off when SOMEONE is generating. If the server has
 *  never answered at all (stopped dev server, dead network), every tick throws
 *  — burning the full 4-minute budget per attempt kept the kid staring at
 *  "Reconnecting… hang tight!" with the composer locked for ~12 minutes. */
export const UNREACHABLE_MAX_MS = 20_000;

/**
 * Poll for a turn's server-side result.
 *  - `done`   → the finished reply (apply it, no re-generation).
 *  - `error`, 404, or `running` past the budget → null (caller re-generates).
 * Network failures while polling count as misses for that tick, not verdicts —
 * BUT only once the server has answered at least once this poll. A server
 * that has NEVER answered gets the short `unreachableMaxMs` budget instead
 * (nobody is generating — patience buys nothing).
 * `shouldStop` (the kid's ⏹) is honored every tick.
 */
export async function pollTurnResult(
  replyId: string,
  opts: PollOpts = {},
): Promise<ResumedTurn | null> {
  const outcome = await pollTurnOutcome(replyId, opts);
  return outcome.status === "done" ? { text: outcome.text, artifactHtml: outcome.artifactHtml } : null;
}

export interface PollOpts {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxMs?: number;
  intervalMs?: number;
  unreachableMaxMs?: number;
  shouldStop?: () => boolean;
  /** Called after every tick that found the turn still `running` — lets the UI
   *  say "still finishing this" instead of sitting silent for minutes. */
  onRunning?: (waitedMs: number) => void;
}

/** Same poll as `pollTurnResult`, but reports WHICH ending it reached.
 *  A `shouldStop` break reports `running`: the turn isn't finished and isn't
 *  gone — the caller decides what a stop means. */
export async function pollTurnOutcome(replyId: string, opts: PollOpts = {}): Promise<TurnOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxMs = opts.maxMs ?? RESUME_MAX_MS;
  const intervalMs = opts.intervalMs ?? RESUME_INTERVAL_MS;
  const unreachableMaxMs = opts.unreachableMaxMs ?? UNREACHABLE_MAX_MS;

  let reached = false; // any HTTP response at all proves a live server
  for (let waited = 0; ; waited += intervalMs) {
    if (opts.shouldStop?.()) return { status: "running" };
    try {
      const res = await fetchFn(`/api/chat/result?replyId=${encodeURIComponent(replyId)}`, { cache: "no-store" });
      reached = true;
      if (res.status === 404) return { status: "unknown" }; // old server / never started — re-generate
      if (res.ok) {
        const body = (await res.json()) as { status: string; text?: string; artifactHtml?: string | null };
        if (body.status === "done") return { status: "done", text: body.text ?? "", artifactHtml: body.artifactHtml ?? null };
        if (body.status === "error") return { status: "error" }; // server-side failure — re-generate
        opts.onRunning?.(waited); // `running` → fall through and keep waiting
      }
    } catch {
      /* offline tick — keep polling until the (right) budget runs out */
    }
    if (waited + intervalMs > (reached ? maxMs : Math.min(maxMs, unreachableMaxMs))) {
      return reached ? { status: "running" } : { status: "unknown" };
    }
    await sleep(intervalMs);
  }
}
