# PRD — Model Fallback & Degraded-Mode Experience (one-pager)

2026-07-11 · Status: v1 — Phase 1 shipped (stream-open fallback), rest proposed
Trigger: prod incident 2026-07-11 — hours of Gemini 503 "high demand" turned
every chat into "Oops! Something went wrong." (BUG-FIX-LOG same date).

## 1. Principle

A kid should never see an error for a problem a different model could have
absorbed. Fallback is for **capacity and availability** problems only — it is
NEVER a way around safety (a safety block on one model must not be retried on
another; fail closed).

## 2. Where we call Gemini, and the right fallback for each

| Call site | What matters | Primary (prod) | Fallback | Why this pairing |
|---|---|---|---|---|
| Game BUILD turns (`replyStream`, builder mode) | code quality | gemini-3.5-flash | gemini-2.5-flash | previous-gen full model: games stay complete/playable; keep thinking budget |
| Plain chat turns (`replyStream`, budget 0) | latency, tone | gemini-3.5-flash | flash-lite tier | a chat answer from a lite model is indistinguishable to a kid; fastest recovery |
| Self-heal `repair()` | latency (20s wall-clock cap §8.4) | same as chat | flash-lite tier | a repair is a ~8-line patch; a fast lite model beats missing the bail window |

Env knobs: `GEMINI_FALLBACK_MODELS` (comma-separated chain, capped at 4;
legacy single `GEMINI_FALLBACK_MODEL` honored), proposed
`GEMINI_REPAIR_FALLBACK_MODEL` (lite). **Owner-specified chain (2026-07-11**,
superseding v1's two): 3.5-flash (primary) → 3-flash-preview → 2.5-flash →
2.5-flash-lite (primary filtered out; env-capped at 4 fallbacks).
`gemini-3-flash-preview` is the preview id 3.5-flash replaced — same
generation, different pool, still serving.
Latency guard: the primary keeps its retries, each fallback gets ONE attempt —
an incident walks 5 models in ~5 tries, not 15. Retired model ids (404) are
skipped down the chain with a CHECK-CONFIG log, so a Google deprecation can
never dead-end prod (`src/lib/model-fallback.ts`).

## 3. Use cases (when fallback fires — and when it must not)

1. **503 / UNAVAILABLE / "high demand"** (the incident) — Google's pool for
   that model is saturated. Retrying the same model re-enters the same queue;
   a different model is a different pool. → FALL BACK. *(shipped)*
2. **429 RESOURCE_EXHAUSTED** — per-model quota/rate limits are separate per
   model, so a sibling model usually has headroom. → FALL BACK.
3. **Model-id 404/400 after a Google deprecation** — the configured model
   stops existing; without fallback prod is DOWN until someone edits env.
   → FALL BACK + loud operator log (this one is a misconfig alarm, not noise).
4. **Mid-stream death** — the incident's dominant shape (stream accepted,
   503 minutes later while THINKING — pm2 log @433s, 2026-07-11). If NO
   answer text has been sent, the chain restarts on the next model
   transparently (thoughts are ephemeral status lines, safe to restart).
   → FALL BACK. *(shipped)* After answer text started, the error surfaces
   and the client auto-retry owns it (never silently duplicate output);
   routing THAT retry to the fallback stays proposed (Phase 3).
5. **First-token timeout** (thinking stall, no 503) — treat like capacity:
   one fallback attempt inside the server's timeout budget. → FALL BACK.
6. **Safety block / content refusal** — NEVER. Fail closed; a block is a
   verdict, not an outage.
7. **Invalid API key / billing / 4xx request bugs** — NEVER. Fallback would
   fail identically and hide the real defect; throw immediately. *(shipped)*

## 4. Desired output: keeping quality equal

- Fallback uses the SAME system prompt, thinking budget, and output headroom —
  only the model id changes. Quality floor is then enforced by the machinery
  we already have: **every fallback-built game still runs through the
  self-healing verify/repair loop** (PRD-SELF-HEALING-PREVIEW), so a broken
  fallback game gets repaired or surfaces the friendly question, same as ever.
- Telemetry closes the loop: tag `preview_verify` / `preview_repair` events
  and usage rows with the model that ACTUALLY served (today `recordUsage`
  logs the configured primary even when the fallback served — cost attribution
  and quality comparison are both wrong during incidents; fix in Phase 2).
  Then Mixpanel can answer "do fallback games fail verify more often?"

## 5. Making the experience BETTER, not just less broken

1. **Say it like a friend, not a server** — when fallback engages, emit one
   `thinking` event: "My main robot brain is extra busy — my speedy helper is
   building your game! 🤖⚡". Honest, kid-sized, and it resets expectations if
   the game is slightly simpler. No model names, no error codes.
2. **Circuit breaker (the big win during long spikes)** — remember "primary
   is overloaded" for a TTL (start: 90s). While open, new requests go
   STRAIGHT to the fallback — no burned retries, so first token during an
   incident is FASTER than a healthy-day builder turn. One probe request
   half-opens the breaker after the TTL. In-memory is fine (single pm2
   process); scale ceiling: multi-instance needs shared state — note in
   MEMORY_BUDGET review if we ever add a second box.
3. **Exhausted copy with a promise, not a chore** — both models down is now
   rare; when it happens, replace "Ask me again!" with "The robots are super
   busy right now — I'll keep trying! 🤖" + ONE automatic client retry after
   ~30s (visible countdown keeps it honest). Never an infinite loop.
4. **Operator visibility** — `model_fallback` Mixpanel event
   `{from, to, reason, call: chat|build|repair}` + the existing console log.
   A spike of these = incident dashboard for free.

## 6. Phases

- **Phase 1 (shipped 2026-07-11):** fallback CHAIN (owner ladder), triggers:
  refused-at-open AND died-mid-thinking (pre-answer), 503/429/deprecation,
  chat/build. `model-fallback.test.ts` + `gemini.fallback.test.ts` F.1–F.7.
- **Phase 2 (proposed, ~half day):** circuit breaker + kid-facing fallback
  line + actual-model usage/telemetry attribution + 429/timeout triggers.
- **Phase 3 (proposed):** repair-call fallback (lite), retry-on-fallback for
  mid-stream drops, auto-retry countdown copy.

## 7. Non-goals

- Cross-provider fallback (Claude/OpenAI): different SDK, prompt-portability
  and child-safety posture review — out of scope until Gemini reliability
  proves chronically insufficient.
- Cost-based routing of easy turns to cheap models on healthy days: adjacent
  but different feature; revisit with usage data.

## 8. Scale ceilings

Circuit breaker state is per-process memory (1 pm2 instance today — fine).
Trigger to revisit: second app instance or serverless move → needs shared
breaker state (SQLite row or Redis).
