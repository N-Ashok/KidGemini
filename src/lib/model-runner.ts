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
import type { GenerationRequest, NormalizedUsage } from "@/types/model-provider.types";
import type { AttemptEvent, ChainSummary } from "@/types/model-ledger.types";

/**
 * What a non-Google generation adapter exposes to gemini.ts's dispatch. Every
 * provider (OpenAI, Anthropic, Moonshot) implements this so the streaming AND
 * one-shot paths can route by provider without knowing any SDK. `openStream`
 * feeds runStreamChain; `generateOnce` feeds runOneShotChain (cross-provider
 * one-shot, PRD-MODEL-FALLBACK §7).
 */
export interface ProviderGenerator {
  openStream(model: string, req: GenerationRequest): Promise<AsyncIterable<ProviderChunk>>;
  generateOnce(model: string, req: GenerationRequest): Promise<{ text: string; usage?: NormalizedUsage }>;
}

/**
 * Why a provider ended a stream, normalized across SDKs (KNOWN_BUGS #4). The
 * runner treats these differently: `safety` is a VERDICT (fail closed — never
 * retry on another model to bypass it), `max_tokens` is FIXABLE (retry the same
 * model once with a smaller thinking budget), everything else is a plain dud
 * slot that walks the chain.
 */
export type FinishReason = "safety" | "max_tokens" | "stop" | "other";

/** One normalized piece of provider output. Adapters translate their own SDK
 *  shape into these, so the runner never sees a `candidates[0].content.parts`
 *  or an OpenAI SSE delta. `usage` is cumulative — last one seen wins. */
export interface ProviderChunk {
  text?: string;
  /** A thought/reasoning summary, NOT part of the answer. */
  thought?: boolean;
  usage?: TokenUsage;
  /** Set on the terminal chunk when the provider reports why it stopped. */
  finishReason?: FinishReason;
  /** On a SAFETY finish only: a compact per-category ratings summary (e.g.
   *  "HATE_SPEECH:MEDIUM(blocked)") so a block can be attributed to a category.
   *  Provider-agnostic string — the adapter normalizes its own shape. */
  safetyInfo?: string;
}

export interface StreamChainDeps {
  /** Models to try, in order (primary first). */
  chain: string[];
  /** Open a stream for `model`. `retries` is the caller's retry budget for
   *  this slot — the primary keeps its normal retries, fallbacks get 0 so a
   *  full incident walks the chain in ~a handful of tries, not 15. `opts`
   *  carries the ONE MAX_TOKENS retry signal: reopen the same model with a
   *  smaller thinking budget so the output allowance isn't eaten by thinking
   *  (KNOWN_BUGS #4). A 2-arg adapter that ignores it is fine. */
  openStream: (model: string, retries: number, opts?: { reducedThinkingBudget?: boolean }) => Promise<AsyncIterable<ProviderChunk>>;
  /** Per-model, because "overloaded" differs by provider (Google 503 vs
   *  OpenAI's two opposite meanings for 429). */
  shouldTryNextModel: (model: string, err: unknown) => boolean;
  /** Retired id → log CHECK CONFIG rather than a generic overload line. */
  isModelGone: (model: string, err: unknown) => boolean;
  stallMs: number;
  /** Wraps the final throw in the caller's own error type. */
  wrapError: (err: unknown) => Error;
  /** Per-request decision ledger sink (owner ask 2026-07-21). Called EXACTLY
   *  once when the chain settles (win or total failure) with every call made
   *  for this request + the winner. Side-effect only — the caller writes it to
   *  logs/model-decisions.jsonl; a throw here is swallowed so it can never
   *  break a turn. */
  onLedger?: (summary: ChainSummary) => void;
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
 * Internal marker: a stream ended with finishReason SAFETY — the provider
 * BLOCKED the candidate (KNOWN_BUGS #4). This is a VERDICT, not an outage, so
 * it is TERMINAL: the chain must NOT walk to another model to get around a
 * child-safety block. It propagates raw (never wrapped, never
 * shouldTryNextModel'd) so the route can turn it into a friendly "let's talk
 * about something else" redirect instead of an error or a blank bubble.
 */
export class SafetyBlockedError extends Error {
  /** Compact per-category ratings summary (e.g. "HATE_SPEECH:MEDIUM(blocked)")
   *  when the provider reported them — lets the route LOG which category fired,
   *  to tell a genuine block from a false-positive (owner ask 2026-07-22). */
  readonly safetyInfo?: string;
  constructor(model: string, safetyInfo?: string) {
    super(`safety block: ${model} finished the stream with finishReason SAFETY`);
    this.name = "SafetyBlockedError";
    this.safetyInfo = safetyInfo;
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
  const { chain, openStream, shouldTryNextModel, isModelGone, stallMs, wrapError, onLedger } = deps;

  // Elapsed since the chain opened, stamped on every trigger/win line so the
  // operator log makes it OBVIOUS when the 2nd/3rd model kicked in and which
  // one served (owner ask 2026-07-21). The file logger tees these to app.log.
  const t0 = Date.now();
  const at = () => `@${Date.now() - t0}ms`;
  const depth = chain.length;

  // Per-request decision ledger: one record per model call, flushed to onLedger
  // when the chain settles. `role` explains WHY each call was made; the sink
  // turns it into a line in logs/model-decisions.jsonl.
  const attempts: AttemptEvent[] = [];
  let winner: string | null = null;
  const roleAt = (i: number) => (i === 0 ? "primary" : `fallback#${i + 1}`);
  const rec = (model: string, role: string, outcome: string, chars?: number) =>
    attempts.push({ model, role, outcome, atMs: Date.now() - t0, ...(chars !== undefined ? { chars } : {}) });

  let answerStarted = false;
  // Answer chars committed by the current winner — reset whenever a partial is
  // wiped, so the ledger's `chars` reflects what was actually served.
  let answerChars = 0;
  // Set when a model died after visible answer text; the NEXT model that
  // actually produces output is prefixed with one `restart` chunk. Survives
  // models that fail at open (no output → nothing new to wipe).
  let pendingRestart = false;
  // At most ONE hedge per TURN (not per chain slot).
  let hedged = false;
  let lastErr: unknown = null;

  try {
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    if (i > 0) console.warn(`[model-runner] ${reasonFor(model, lastErr, isModelGone)} — falling back to model #${i + 1}/${depth} ${model} ${at()}`);
    let stream: AsyncIterable<ProviderChunk>;
    try {
      stream = await openStream(model, i === 0 ? 2 : 0);
    } catch (err) {
      lastErr = err;
      rec(model, roleAt(i), reasonFor(model, err, isModelGone));
      if (!shouldTryNextModel(model, err)) throw wrapError(err);
      continue;
    }

    interface Src {
      model: string;
      role: string;
      it: AsyncIterator<ProviderChunk>;
      pending?: Promise<{ src: Src; res?: IteratorResult<ProviderChunk>; err?: unknown }>;
      usage?: TokenUsage;
      /** Last finishReason this source reported — decides SAFETY vs MAX_TOKENS. */
      finish?: FinishReason;
      /** Per-category ratings summary on a SAFETY finish (attribution logging). */
      safetyInfo?: string;
      /** True once this model's ONE reduced-budget MAX_TOKENS retry has run. */
      budgetRetried?: boolean;
    }
    let srcs: Src[] = [{ model, role: roleAt(i), it: stream[Symbol.asyncIterator]() }];
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
            console.warn(`[model-runner] ${srcs.map((s) => s.model).join("+")} silent ${stallMs}ms — hedging with model #${i + 2}/${depth} ${hedgeModel} (race, first answer wins) ${at()}`);
            try {
              const hedgeStream = await openStream(hedgeModel, 0);
              srcs.push({ model: hedgeModel, role: "hedge", it: hedgeStream[Symbol.asyncIterator]() });
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
            rec(src.model, src.role, "died (hedge racer)");
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
          // Finished, but with NOTHING to show. WHY decides what happens
          // (KNOWN_BUGS #4): a SAFETY block is a verdict (fail closed, terminal);
          // a MAX_TOKENS finish is fixable (retry THIS model once with a smaller
          // thinking budget so it isn't eaten by thinking); anything else is a
          // plain dud slot that walks the chain rather than handing the child a
          // blank bubble. Checked against answerSrc, not just answerStarted, so a
          // slot that produced nothing after an EARLIER model's text was wiped
          // still counts as empty.
          if (!answerStarted || answerSrc !== src) {
            if (src.finish === "safety") throw new SafetyBlockedError(src.model, src.safetyInfo);
            if (src.finish === "max_tokens" && !src.budgetRetried && srcs.length === 1) {
              try {
                const reopened = await openStream(model, 0, { reducedThinkingBudget: true });
                console.warn(`[model-runner] ${model} hit MAX_TOKENS — retrying once with a smaller thinking budget`);
                srcs = [{ model, role: roleAt(i), it: reopened[Symbol.asyncIterator](), budgetRetried: true }];
                continue; // pump the reopened stream; a real answer this time wins
              } catch (reErr) {
                // Reopen refused: fall through to the ordinary dud-slot walk.
                if (!shouldTryNextModel(model, reErr)) throw reErr;
              }
            }
            throw new EmptyCompletionError(src.model);
          }
          // Real billed counts, tagged with the model that ACTUALLY served.
          if (src.usage) yield { kind: "usage", text: "", model: src.model, usage: src.usage };
          // Name the winner + elapsed so the log says WHICH model produced the
          // answer, on every turn (not only fallbacks). route.ts logs the final
          // "shown to the user" line after any patch/regen handling.
          console.log(`[model-runner] ✓ served by ${src.model} (model #${chain.indexOf(src.model) + 1}/${depth}) ${at()}`);
          winner = src.model;
          rec(src.model, src.role, "won", answerChars);
          return; // the (sole/committed) stream finished cleanly
        }

        const part = won.res!.value;
        if (part.usage) src.usage = part.usage;
        if (part.finishReason) src.finish = part.finishReason;
        if (part.safetyInfo) src.safetyInfo = part.safetyInfo;
        if (!part.text) continue;

        if (part.thought) {
          // Thoughts from either racer feed the kid's planning line. A pending
          // restart flushes here too (the new model has started responding →
          // wipe the stale partial) — but never while a race is undecided: the
          // wipe must wait for a committed winner.
          if (pendingRestart && srcs.length === 1) {
            pendingRestart = false;
            answerStarted = false;
            answerChars = 0;
            yield { kind: "restart", text: "" };
          }
          yield { kind: "thought", text: part.text };
          continue;
        }

        // First ANSWER token commits this source and settles the race.
        if (srcs.length > 1) {
          for (const s of srcs) if (s !== src) { rec(s.model, s.role, "abandoned (lost race)"); abandon(s); }
          srcs = [src];
          console.warn(`[model-runner] race won by ${src.model} ${at()}`);
        }
        if (answerStarted && answerSrc !== src) {
          // A different model had already streamed answer text (pre-hedge
          // partial): wipe it rather than stitching two answers.
          pendingRestart = true;
        }
        if (pendingRestart) {
          pendingRestart = false;
          answerStarted = false;
          answerChars = 0;
          yield { kind: "restart", text: "" };
        }
        answerStarted = true;
        answerSrc = src;
        answerChars += part.text.length;
        yield { kind: "delta", text: part.text };
      }
    } catch (err) {
      // Mid-stream death: real defects surface; transient failures AND silence
      // past the hedge window walk the chain. If answer text already went out,
      // flag a restart so the next producing model wipes it clean.
      // Stalls and empty completions are OUR markers for a dud slot, not
      // provider errors — the per-provider classifier would not recognise
      // them, so they bypass it and always walk.
      // A SAFETY block is a verdict, not an outage: fail closed. Abandon every
      // stream and propagate raw — never walk to another model to bypass it,
      // never wrap it (the route needs the type to send a friendly redirect).
      if (err instanceof SafetyBlockedError) {
        for (const s of srcs) abandon(s);
        rec(model, roleAt(i), "safety");
        console.warn(`[model-runner] ${model} was safety-blocked — failing closed (no fallback)`);
        throw err;
      }
      const stalled = err instanceof StallSwitchError;
      const empty = err instanceof EmptyCompletionError;
      for (const s of srcs) abandon(s);
      if (!stalled && !empty && !shouldTryNextModel(model, err)) { rec(model, roleAt(i), "error"); throw err; }
      lastErr = err;
      const how = stalled ? "went silent" : empty ? "returned nothing" : "died";
      rec(model, roleAt(i), how);
      if (answerStarted) {
        pendingRestart = true;
        console.warn(`[model-runner] ${model} ${how} mid-answer — restarting fresh on the next model ${at()}`);
      } else {
        console.warn(`[model-runner] ${model} ${how} mid-thinking — trying the next model ${at()}`);
      }
    }
  }
  throw wrapError(lastErr);
  } finally {
    // Flush the per-request ledger exactly once, whether we won or exhausted the
    // chain. Swallow any sink error — bookkeeping must never break a turn.
    if (onLedger) { try { onLedger({ chain, attempts, winner }); } catch { /* never breaks a turn */ } }
  }
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
  /** Per-request decision ledger sink — same contract as runStreamChain's:
   *  fired once with every concurrent call made + the winner (owner ask
   *  2026-07-21). This chain FANS OUT (earlier attempts stay alive as backups
   *  are added), so the ledger is where "we made N billable calls, one won"
   *  becomes visible — usage_events records only the winner. */
  onLedger?: (summary: ChainSummary) => void;
  /** Fired for every LOSING attempt still in flight when the winner returns —
   *  once each settles (owner ask 2026-07-21). The chain keeps losers running,
   *  so this is REAL, already-paid work: the caller maps the settled result to
   *  its billed usage and records it as `kind:"fallback"` cost. Fire-and-forget
   *  (fires after this function has already returned the winner); a throw in the
   *  sink is swallowed so it can never affect the turn. Errored settlements are
   *  reported too (with `err`) — the caller bills only value-bearing ones. */
  onLoserResult?: (model: string, result: { value?: T; err?: unknown }) => void;
}): Promise<T> {
  const { chain, label, primaryRetries, call, shouldTryNextModel, isModelGone, slotDeadlineMs, onLedger, onLoserResult } = deps;
  // Attach observers to every attempt still running when the winner is returned.
  // The promises are already in flight (this chain never cancels a laggard), so
  // observing them just means their real result/usage isn't thrown away.
  const observeLosers = () => {
    if (!onLoserResult) return;
    for (const a of inflight) {
      void a.p.then((s) => { try { onLoserResult(s.model, { value: s.value, err: s.err }); } catch { /* never breaks a turn */ } });
    }
  };
  const totalBudgetMs = deps.totalBudgetMs ?? slotDeadlineMs * (chain.length + 1);
  const t0 = Date.now();
  const deadline = t0 + totalBudgetMs;
  const at = () => `@${Date.now() - t0}ms`;
  const depth = chain.length;

  // Decision ledger for this request. role explains WHY each call was fired.
  const attempts: AttemptEvent[] = [];
  let winner: string | null = null;
  const roleOf = (m: string) => { const i = chain.indexOf(m); return i === 0 ? "primary" : `backup#${i + 1}`; };
  const rec = (model: string, outcome: string) => attempts.push({ model, role: roleOf(model), outcome, atMs: Date.now() - t0 });

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

  try {
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    if (i > 0) console.warn(`[model-runner] ${reasonFor(model, lastErr, isModelGone)} — adding model #${i + 1}/${depth} ${model} as a backup (${label}); earlier attempts stay alive ${at()}`);
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
      if (done.err === undefined) { // FIRST success wins
        console.log(`[model-runner] ✓ ${label} served by ${done.model} (model #${chain.indexOf(done.model) + 1}/${depth}) ${at()}`);
        winner = done.model;
        rec(done.model, "won");
        observeLosers(); // bill the backups still running (they're already paid for)
        return done.value as T;
      }
      lastErr = done.err;
      rec(done.model, reasonFor(done.model, done.err, isModelGone));
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
    if (done.err === undefined) {
      console.log(`[model-runner] ✓ ${label} served by ${done.model} (model #${chain.indexOf(done.model) + 1}/${depth}, past the chain) ${at()}`);
      winner = done.model;
      rec(done.model, "won");
      observeLosers();
      return done.value as T;
    }
    lastErr = done.err;
    rec(done.model, reasonFor(done.model, done.err, isModelGone));
    if (!shouldTryNextModel(done.model, done.err)) throw done.err;
  }

  if (lastErr !== undefined) throw lastErr;
  throw new Error(`${label}: gave up after ${totalBudgetMs}ms — no model produced an answer within the budget`);
  } finally {
    // Any attempt still running when we settled is a real call that was left to
    // finish (or was cut by the budget) — record it so the ledger's call count
    // matches how many model calls this request actually fired.
    for (const a of inflight) rec(a.model, "inflight (running at settle)");
    if (onLedger) { try { onLedger({ chain, attempts, winner }); } catch { /* never breaks a turn */ } }
  }
}
