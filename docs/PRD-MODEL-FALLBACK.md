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
   → FALL BACK. *(shipped)* After answer text started (2026-07-13 incident,
   owner decision): the partial code is only a "system is working" signal —
   the chain STILL walks to the next model, and a `restart` stream event is
   emitted right before that model's first output so the client wipes the
   partial chat bubble alone and relays the fresh thoughts + code. The
   accumulator resets server-side too (done/usage never carry wiped text).
   → FALL BACK + RESTART EVENT. *(shipped)*
4b. **Transient 5xx that isn't a clean 503** (500 INTERNAL, 502, 504) and
   network-level drops (`fetch failed`, `ECONNRESET`, `socket hang up`,
   `terminated`) — same transient class the retry layer recognizes; the
   chain must agree (2026-07-13, split-brain taxonomy fix). → FALL BACK.
   *(shipped)*
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

> **See also `docs/PRD-RESILIENT-GENERATION.md`** (2026-07-20, proposed): the
> chain currently ABANDONS in-flight work at each deadline and then serves a
> weaker model's answer, even though the better model's answer had almost
> certainly already arrived. That is a quality problem, not a cost one, and it
> is tracked there with a decision table.

## 7. Cross-provider fallback — NOW A GOAL (owner decision 2026-07-20)

Supersedes the previous non-goal ("different SDK, prompt-portability and
child-safety posture review — out of scope"). The SDK objection is answered by
an adapter per provider; the other two are NOT, and are tracked below.

**Routing rule (owner):** models of the same capability tier are treated as
interchangeable, so the chain orders by **quality tier first, then price within
that tier**, crossing providers freely. Pure cheapest-first was tried and
rejected in implementation — it filled all four slots with the cheapest models,
so a failed game-BUILD turn fell straight to a lite model and shipped a
visibly worse game (`model-registry.test.ts` R.14 pins this).

Shipped (2026-07-20), owner chose **option A** (moderation adapter):

| Piece | File | Tests |
|---|---|---|
| Provider abstraction | `src/types/model-provider.types.ts` | — |
| Catalog + price-ordered `chainFor()` | `src/lib/model-registry.ts` | 15 |
| OpenAI error taxonomy | `src/lib/providers/openai-adapter.ts` | 9 |
| OpenAI moderation (the option-A safety layer) | `src/lib/providers/openai-moderation.ts` | 12 |
| Provider-agnostic chain runner | `src/lib/model-runner.ts` | via F.1–F.7 |
| Billing derived from one price source | `src/lib/pricing.config.ts` | 2 |

The runner is the hedged-race state machine lifted verbatim out of
`GeminiChatModel.replyStream`; `gemini.fallback.test.ts` passes untouched,
which is the proof the extraction changed no behaviour.

**Live as of 2026-07-20** — streaming chat turns now fail over to OpenAI. With
`OPENAI_API_KEY` set, the production chain (primary `gemini-3.5-flash`) is:

```
gpt-5.6-luna  →  gemini-2.5-flash  →  gemini-3-flash-preview  →  gpt-5.4-mini
```

`gpt-5.6-luna` leads because it is the only other **frontier**-tier model and
is cheaper than the primary ($1/$6 vs $1.5/$9) — quality tier first, price
within the tier. Without the OpenAI key the chain is unchanged Gemini-only.
`gpt-*` entries are `provider-enforced` because every OpenAI generation goes
through `OpenAIGenerator`, which moderates the child's message before the model
sees it and the answer before the child sees it.

**OpenAI turns do not token-stream.** The answer is buffered, moderated, then
emitted — there is no way to un-send text a post-hoc moderation pass rejects,
and "games are never blocked or retracted" (CLAUDE.md §3) rules out retraction.
The cost lands only on the rescue path; if the pause proves too long on real
turns the fix is a faster chain model, not streaming unmoderated text.

**Still Gemini-only:** the one-shot paths (`reply` / `repair` /
`strictEditRetry`). They build a Google request directly, so OpenAI ids are
filtered out of their chains rather than handed to Google (which would 404 and
be silently skipped — the exact bug this work removes). Making them
cross-provider needs each call site to supply an adapter-neutral
`GenerationRequest`.

**⚠ Behaviour change to confirm:** the 2026-07-13 ladder escalated a *workhorse*
primary UP to the premium `gemini-3.5-flash` as a deep fallback. `chainFor`
never climbs to a richer tier, so that escalation is gone (`gemini.fallback.test.ts`
F.3 updated). Production is unaffected — the prod primary IS `gemini-3.5-flash`,
so everything catalogued is already cheaper — but if the quality escalation was
wanted for a cheaper primary, pin it with `MODEL_FALLBACK_CHAIN`.

Anthropic and Moonshot/Kimi remain planned adapters — the registry reserves
their provider ids and env keys. Kimi additionally needs the DATA_HANDLING
review below before a key is added at all.

**The feature is currently INERT, by design.** Ari's documented safety posture
(CLAUDE.md §3) has provider-enforced thresholds as its middle layer, and only
Gemini exposes them per request (`safetySettings`). Every non-Gemini model is
marked `prompt-only` and excluded from every chain unless
`ALLOW_PROMPT_ONLY_SAFETY_MODELS=1` is set. So nothing routes off Google until
one of these is chosen:

| Option | What it means | Cost |
|---|---|---|
| **A. Moderation adapter** | Each non-Gemini adapter runs an explicit moderation pass (e.g. OpenAI's moderation endpoint) pre/post generation, then legitimately claims `provider-enforced` | Real work per provider; extra call adds latency to the rescue path |
| **B. Accept prompt-only for rescue** | Flip the flag: during an outage a kid may get a reply with only input rules + system prompt guarding it | Free; lowers the safety floor exactly when volume is highest |
| **C. Stay Gemini-only for kid-facing** | Cross-provider used only for non-kid-facing calls (verify/repair on generated CODE, classifiers) | Keeps the floor; much smaller resilience win |

Open items regardless of choice: **prompt portability** (the child-safety system
prompt and the game-build contract are tuned on Gemini — an untested prompt on
another model is an unmeasured quality AND safety change) and, for Moonshot/Kimi
specifically, **data handling** — children's transcripts leaving for a new
jurisdiction needs a `docs/DATA_HANDLING.md` review before any key is added.

### Known gap opened by this change
`pricing.config.ts` resolves prices by model id from a Gemini-only table, so a
non-Gemini turn would bill on the admin dashboard at the unknown-model fallback
rate ($1.5/$9) — same class as BUG-FIX-LOG 2026-07-13's "$0 dashboard". Not
live (nothing routes off Google yet). Fix = derive `MODEL_PRICING` from
`MODEL_CATALOG` so there is one price source; own change, own tests.

## 7b. Non-goals

- Cost-based routing of easy turns to cheap models on healthy days: adjacent
  but different feature; revisit with usage data.

## 8. Scale ceilings

Circuit breaker state is per-process memory (1 pm2 instance today — fine).
Trigger to revisit: second app instance or serverless move → needs shared
breaker state (SQLite row or Redis).
