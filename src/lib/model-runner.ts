// Provider-agnostic fallback-chain runner (owner decision 2026-07-20).
//
// This is the hedged-race state machine LIFTED VERBATIM out of
// GeminiChatModel.replyStream — same semantics, no Google types. Every branch
// here traces to a production incident, so treat it as load-bearing:
//   · 2026-07-11 — capacity refusal at open → walk the chain (kids saw
//     "Oops! Something went wrong." for hours).
//   · 2026-07-13 — death AFTER answer text had streamed → walk the chain AND
//     emit `restart` so the client wipes the partial bubble instead of
//     stitching two answers together.
//   · 2026-07-13 — a model that emits nothing at all past the stall window
//     gets ONE hedge: the next chain model runs in PARALLEL and the first
//     answer token commits the winner. At most one hedge per turn — no
//     thundering herd exactly when the provider is already overloaded.
//
// The chain is now cross-provider (model-registry.chainFor), so `openStream`
// and the error classifiers are injected per model rather than assumed to be
// Google's. gemini.fallback.test.ts F.1–F.7 is the regression net for this
// file and must keep passing untouched.

import type { StreamChunk, TokenUsage } from "@/types/chat.types";

/** One normalized piece of provider output. Adapters translate their own SDK
 *  shape into these, so the runner never sees a `candidates[0].content.parts`
 *  or an OpenAI SSE delta. `usage` is cumulative — last one seen wins. */
export interface ProviderChunk {
  text?: string;
  /** A thought/reasoning summary, NOT part of the answer. */
  thought?: boolean;
  usage?: TokenUsage;
}

export interface StreamChainDeps {
  /** Models to try, in order (primary first). */
  chain: string[];
  /** Open a stream for `model`. `retries` is the caller's retry budget for
   *  this slot — the primary keeps its normal retries, fallbacks get 0 so a
   *  full incident walks the chain in ~a handful of tries, not 15. */
  openStream: (model: string, retries: number) => Promise<AsyncIterable<ProviderChunk>>;
  /** Per-model, because "overloaded" differs by provider (Google 503 vs
   *  OpenAI's two opposite meanings for 429). */
  shouldTryNextModel: (model: string, err: unknown) => boolean;
  /** Retired id → log CHECK CONFIG rather than a generic overload line. */
  isModelGone: (model: string, err: unknown) => boolean;
  stallMs: number;
  /** Wraps the final throw in the caller's own error type. */
  wrapError: (err: unknown) => Error;
}

/** Internal marker: every live stream went silent past the watchdog window. */
export class StallSwitchError extends Error {
  constructor(model: string, ms: number) {
    super(`stall-switch: ${model} produced no chunks for ${ms}ms`);
    this.name = "StallSwitchError";
  }
}

/**
 * Internal marker: a stream ended CLEANLY but produced no answer text.
 *
 * BUG-FIX-LOG 2026-07-20 ("walked four fallbacks and returned nothing"). A
 * provider can finish a stream with nothing to show — Gemini finishReason
 * MAX_TOKENS (a builder turn whose thinking budget consumed the entire output
 * allowance), finishReason SAFETY (candidate blocked), or an empty candidate
 * list; OpenAI can return a completion with an empty content string. Nothing
 * reads finishReason, so this arrived as a plain `done` and the runner treated
 * it as SUCCESS: it returned having emitted nothing and never tried the next
 * model. The child got a blank bubble, and when earlier slots had genuinely
 * failed first, the logs showed a full fallback walk ending in silence.
 *
 * Modelled as a failure so it walks the chain like any other dud slot. Thought
 * summaries do NOT count as output — they are ephemeral status lines, not an
 * answer.
 */
export class EmptyCompletionError extends Error {
  constructor(model: string) {
    super(`empty completion: ${model} finished the stream without any answer text`);
    this.name = "EmptyCompletionError";
  }
}

/**
 * Why we are moving down the chain, for the operator log.
 *
 * BUG-FIX-LOG 2026-07-20: this used to print "overloaded" for EVERY non-404
 * failure, so a chain that was actually blowing its own 30s deadline on every
 * model logged three lines blaming Google capacity. That single wrong word
 * sent the investigation at a Gemini outage instead of at our own timeout, and
 * the real cause survived for days. Say what actually happened.
 */
function reasonFor(model: string, err: unknown, isModelGone: (m: string, e: unknown) => boolean): string {
  if (isModelGone(model, err)) return "model gone (CHECK CONFIG)";
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError") return "OUR deadline expired (raise the timeout, not the chain)";
  if (name === "EmptyCompletionError") return "returned nothing";
  if (name === "StallSwitchError") return "went silent";
  return "overloaded";
}

export async function* runStreamChain(deps: StreamChainDeps): AsyncGenerator<StreamChunk> {
  const { chain, openStream, shouldTryNextModel, isModelGone, stallMs, wrapError } = deps;

  let answerStarted = false;
  // Set when a model died after visible answer text; the NEXT model that
  // actually produces output is prefixed with one `restart` chunk. Survives
  // models that fail at open (no output → nothing new to wipe).
  let pendingRestart = false;
  // At most ONE hedge per TURN (not per chain slot).
  let hedged = false;
  let lastErr: unknown = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    if (i > 0) console.warn(`[model-runner] ${reasonFor(model, lastErr, isModelGone)} — falling back to ${model}`);
    let stream: AsyncIterable<ProviderChunk>;
    try {
      stream = await openStream(model, i === 0 ? 2 : 0);
    } catch (err) {
      lastErr = err;
      if (!shouldTryNextModel(model, err)) throw wrapError(err);
      continue;
    }

    interface Src {
      model: string;
      it: AsyncIterator<ProviderChunk>;
      pending?: Promise<{ src: Src; res?: IteratorResult<ProviderChunk>; err?: unknown }>;
      usage?: TokenUsage;
    }
    let srcs: Src[] = [{ model, it: stream[Symbol.asyncIterator]() }];
    /** Which source produced the answer tokens yielded so far. */
    let answerSrc: Src | null = null;
    const abandon = (s: Src) => void s.it.return?.(undefined as never); // fire-and-forget

    try {
      pump: while (true) {
        for (const s of srcs) {
          if (!s.pending) {
            s.pending = s.it.next().then(
              (res) => ({ src: s, res }),
              (err) => ({ src: s, err }),
            );
          }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const won = await Promise.race<{ src?: Src; res?: IteratorResult<ProviderChunk>; err?: unknown; timeout?: true }>([
          ...srcs.map((s) => s.pending!),
          new Promise<{ timeout: true }>((resolve) => {
            timer = setTimeout(() => resolve({ timeout: true }), stallMs);
          }),
        ]).finally(() => clearTimeout(timer));

        if (won.timeout) {
          const hedgeModel = chain[i + 1];
          if (!hedged && hedgeModel) {
            hedged = true;
            console.warn(`[model-runner] ${srcs.map((s) => s.model).join("+")} silent ${stallMs}ms — hedging with ${hedgeModel} (race, first answer wins)`);
            try {
              const hedgeStream = await openStream(hedgeModel, 0);
              srcs.push({ model: hedgeModel, it: hedgeStream[Symbol.asyncIterator]() });
            } catch (err) {
              // Hedge refused to open — keep waiting on the original; a real
              // defect still surfaces rather than being masked.
              if (!shouldTryNextModel(hedgeModel, err)) throw err;
              console.warn(`[model-runner] hedge ${hedgeModel} refused to open — staying with ${model}`);
            }
            continue;
          }
          // Already hedged (or nothing left) and STILL silent: give up on this
          // slot and let the outer chain walk continue.
          throw new StallSwitchError(srcs.map((s) => s.model).join("+"), stallMs);
        }

        const src = won.src!;
        src.pending = undefined;
        if (won.err) {
          // One racer died. With another alive, drop the dead one; alone,
          // apply the normal chain policy in the outer catch.
          if (srcs.length > 1 && shouldTryNextModel(src.model, won.err)) {
            console.warn(`[model-runner] hedge racer ${src.model} died — continuing with the other`);
            srcs = srcs.filter((s) => s !== src);
            continue;
          }
          throw won.err;
        }
        if (won.res!.done) {
          if (srcs.length > 1 && src !== answerSrc) {
            // An uncommitted racer ended without ever answering — drop it.
            srcs = srcs.filter((s) => s !== src);
            continue;
          }
          // Finished, but with NOTHING to show: treat as a dud slot and walk
          // the chain rather than handing the child a blank bubble (see
          // EmptyCompletionError). Checked against answerSrc, not just
          // answerStarted, so a slot that produced nothing after an EARLIER
          // model's text was wiped still counts as empty.
          if (!answerStarted || answerSrc !== src) throw new EmptyCompletionError(src.model);
          // Real billed counts, tagged with the model that ACTUALLY served.
          if (src.usage) yield { kind: "usage", text: "", model: src.model, usage: src.usage };
          return; // the (sole/committed) stream finished cleanly
        }

        const part = won.res!.value;
        if (part.usage) src.usage = part.usage;
        if (!part.text) continue;

        if (part.thought) {
          // Thoughts from either racer feed the kid's planning line. A pending
          // restart flushes here too (the new model has started responding →
          // wipe the stale partial) — but never while a race is undecided: the
          // wipe must wait for a committed winner.
          if (pendingRestart && srcs.length === 1) {
            pendingRestart = false;
            answerStarted = false;
            yield { kind: "restart", text: "" };
          }
          yield { kind: "thought", text: part.text };
          continue;
        }

        // First ANSWER token commits this source and settles the race.
        if (srcs.length > 1) {
          for (const s of srcs) if (s !== src) abandon(s);
          srcs = [src];
          console.warn(`[model-runner] race won by ${src.model}`);
        }
        if (answerStarted && answerSrc !== src) {
          // A different model had already streamed answer text (pre-hedge
          // partial): wipe it rather than stitching two answers.
          pendingRestart = true;
        }
        if (pendingRestart) {
          pendingRestart = false;
          answerStarted = false;
          yield { kind: "restart", text: "" };
        }
        answerStarted = true;
        answerSrc = src;
        yield { kind: "delta", text: part.text };
      }
    } catch (err) {
      // Mid-stream death: real defects surface; transient failures AND silence
      // past the hedge window walk the chain. If answer text already went out,
      // flag a restart so the next producing model wipes it clean.
      // Stalls and empty completions are OUR markers for a dud slot, not
      // provider errors — the per-provider classifier would not recognise
      // them, so they bypass it and always walk.
      const stalled = err instanceof StallSwitchError;
      const empty = err instanceof EmptyCompletionError;
      for (const s of srcs) abandon(s);
      if (!stalled && !empty && !shouldTryNextModel(model, err)) throw err;
      lastErr = err;
      const how = stalled ? "went silent" : empty ? "returned nothing" : "died";
      if (answerStarted) {
        pendingRestart = true;
        console.warn(`[model-runner] ${model} ${how} mid-answer — restarting fresh on the next model`);
      } else {
        console.warn(`[model-runner] ${model} ${how} mid-thinking — trying the next model`);
      }
    }
  }
  throw wrapError(lastErr);
}

/**
 * One-shot chain that NEVER DISCARDS an attempt
 * (owner decision 2026-07-20, PRD-RESILIENT-GENERATION option 3).
 *
 * The old shape was serial-abandon-degrade: run the primary, cut it at a hard
 * deadline, throw the in-flight work away, start a WEAKER model from zero, and
 * serve whatever that produced. Production showed why that is the wrong shape —
 * the deadline was 30s while the same work streamed successfully at 31.2s and
 * 46.4s, so the primary's better answer had almost always already arrived,
 * unheard, by the time a lite model replied (BUG-FIX-LOG 2026-07-20).
 *
 * Now `slotDeadlineMs` only ADVANCES the chain: when it passes we start the
 * next model as a BACKUP and keep every earlier attempt running. The first
 * attempt to succeed wins, whoever it is. This matters because an attempt that
 * has been running for a full slot is far closer to done than a backup
 * starting from zero — so the better model usually still wins, and we degrade
 * only when it is genuinely dead.
 *
 * `call` must NOT wrap itself in a timeout; deadlines belong to the chain now.
 * `totalBudgetMs` is the hard stop so a hung provider cannot strand the turn.
 */
export async function runOneShotChain<T>(deps: {
  chain: string[];
  label: string;
  primaryRetries: number;
  call: (model: string, retries: number) => Promise<T>;
  shouldTryNextModel: (model: string, err: unknown) => boolean;
  isModelGone: (model: string, err: unknown) => boolean;
  /** How long to wait on the current set before starting the next backup. */
  slotDeadlineMs: number;
  /** Hard ceiling for the whole turn. Defaults to a slot per model plus one. */
  totalBudgetMs?: number;
}): Promise<T> {
  const { chain, label, primaryRetries, call, shouldTryNextModel, isModelGone, slotDeadlineMs } = deps;
  const totalBudgetMs = deps.totalBudgetMs ?? slotDeadlineMs * (chain.length + 1);
  const deadline = Date.now() + totalBudgetMs;

  interface Attempt { model: string; p: Promise<{ model: string; value?: T; err?: unknown }> }
  const inflight: Attempt[] = [];
  let lastErr: unknown;

  const start = (model: string, i: number): Attempt => ({
    model,
    // Tagged so a settled promise can be matched back to its attempt without
    // Promise.any's error-aggregation semantics (which would hide WHICH failed).
    p: call(model, i === 0 ? primaryRetries : 0).then(
      (value) => ({ model, value }),
      (err) => ({ model, err }),
    ),
  });

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    if (i > 0) console.warn(`[model-runner] ${reasonFor(model, lastErr, isModelGone)} — adding ${model} as a backup (${label}); earlier attempts stay alive`);
    inflight.push(start(model, i));

    // Wait for a winner, a fatal error, or this slot's deadline.
    while (inflight.length > 0) {
      const remaining = Math.min(slotDeadlineMs, deadline - Date.now());
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.race(inflight.map((a) => a.p)),
        new Promise<{ slotExpired: true }>((r) => { timer = setTimeout(() => r({ slotExpired: true }), remaining); }),
      ]).finally(() => clearTimeout(timer));

      if ((settled as { slotExpired?: true }).slotExpired) break; // widen the net, discard nothing

      const done = settled as { model: string; value?: T; err?: unknown };
      const idx = inflight.findIndex((a) => a.model === done.model);
      if (idx >= 0) inflight.splice(idx, 1);
      if (done.err === undefined) return done.value as T; // FIRST success wins
      lastErr = done.err;
      // A real defect surfaces immediately — fallback must never mask one.
      if (!shouldTryNextModel(done.model, done.err)) throw done.err;
      console.warn(`[model-runner] ${done.model} failed (${label}): ${(done.err as Error)?.message ?? done.err}`);
    }
    if (Date.now() >= deadline) break;
  }

  // Chain exhausted but attempts may still be in flight — this is the whole
  // point: give the best-quality laggard its remaining budget rather than
  // failing a turn whose answer is seconds away.
  while (inflight.length > 0 && Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.race(inflight.map((a) => a.p)),
      new Promise<{ expired: true }>((r) => { timer = setTimeout(() => r({ expired: true }), Math.max(0, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
    if ((settled as { expired?: true }).expired) break;
    const done = settled as { model: string; value?: T; err?: unknown };
    const idx = inflight.findIndex((a) => a.model === done.model);
    if (idx >= 0) inflight.splice(idx, 1);
    if (done.err === undefined) return done.value as T;
    lastErr = done.err;
    if (!shouldTryNextModel(done.model, done.err)) throw done.err;
  }

  if (lastErr !== undefined) throw lastErr;
  throw new Error(`${label}: gave up after ${totalBudgetMs}ms — no model produced an answer within the budget`);
}
