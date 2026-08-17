# PRD — Vertex AI backend switch + DeepSeek in the fallback chain

2026-08-12 · Status: **BUILT, off by default** (both gates unset = today's
behaviour, byte for byte) · Owner ask, same date, verbatim: *"can you implement
this with an env gate to move between this and the other method at will"* and
*"i also want to make deepseek functional in the fall back"*.

Companion docs: `PRD-MODEL-FALLBACK.md` (the chain this plugs into),
`DATA_HANDLING.md` (China-based providers), platform `docs/TECH_DEBT.md`
(cost-dashboard gap this widens).

---

## 1. Principle

> Which *transport* serves Gemini is an operational choice. Which *safety floor*
> a child gets is not.

The Vertex switch changes only the former. Everything a turn's quality and
safety depend on — model ids, `safetySettings`, thinking budgets, the fallback
chain, the Flash-Lite safety classifier — is identical on both backends. Flip
it, flip it back, nothing else moves.

DeepSeek is the opposite kind of change: a genuinely weaker safety floor, so it
ships **reachable but not routable** — behind the same double gate as Claude and
Kimi.

---

## 2. Tech Feasibility

1. **Vertex express mode is a one-flag change.** The owner-supplied snippet uses
   `genai.Client(vertexai=True, api_key=...)` — express mode: no service
   account, no ADC, no project/location. `@google/genai` v2 (already a
   dependency) accepts the same two options, so the TypeScript switch is
   `new GoogleGenAI({ vertexai: true, apiKey })`. **Confirmed** — typechecks
   against the installed SDK types.
2. **Two client construction sites, not one.** `gemini.ts:395` (generation) and
   `safety.ts:64` (the Flash-Lite classifier). They MUST move together: a split
   would put the gate on a different backend from the model it gates. Hence one
   shared module rather than two edits.
3. **The chain's key check was Studio-only.** `PROVIDER_KEY.google` read
   `GEMINI_API_KEY` alone, so a correctly cut-over Vertex box (VERTEX_API_KEY
   set, GEMINI_API_KEY unset) would have dropped **every Google model from every
   chain** — a total-outage-shaped bug produced by a *working* config. Fixed
   here: either key proves Google is routable, and the exact key for the chosen
   backend is enforced at client construction, which fails with an actionable
   message instead of a silently empty chain. (Tests R.30/R.31.)
4. **DeepSeek is OpenAI-API-compatible**, so it reuses the OpenAI request/SSE
   shape and `buildMessages` — the same arrangement Moonshot already uses. The
   adapter delegates the entire error taxonomy to `openaiAdapter`.
5. **DeepSeek has two shape differences** from Moonshot that matter:
   `deepseek-reasoner` streams chain-of-thought in a separate
   `reasoning_content` delta, and reports cache hits as
   `prompt_cache_hit_tokens`. Reading the first as answer text would print the
   model's private reasoning into a child's chat and wrap every generated game
   in thinking prose. Both handled; DS.2/DS.3/DS.6 pin them.
6. **DeepSeek has no moderation endpoint** to front it with, the way
   `openai-generation.ts` fronts OpenAI. So it is honestly `prompt-only` and
   inherits the existing fail-closed gate. Marking it `provider-enforced` to
   unlock cheap routing would be lying to the gate that protects the kids.
7. **Rule 11 check.** Nothing is re-sourced. Both features are additive and
   inert until an env var is typed; with both unset the code path is identical
   to 2026-08-11. No production coverage count is needed because no live value
   changes source.
8. **Rule 12 check.** A green suite proves the option *shape*, never that a key,
   backend, model id and region line up. Hence `scripts/check-model-backend.mjs`
   — the instrument, built before the UAT ask.

---

## 3. Tech Plan

### 3.1 The switch (`src/lib/google-backend.ts`, new)

One module, two exported functions, no SDK import — pure logic, unit-testable.

```
GEMINI_BACKEND unset | "studio"  → { apiKey: GEMINI_API_KEY }
GEMINI_BACKEND       = "vertex"  → { vertexai: true, apiKey: VERTEX_API_KEY }
GEMINI_BACKEND       = anything  → throw at boot
```

Three deliberate decisions:

| Decision | Why |
|---|---|
| Unknown value **throws** rather than defaulting to studio | A typo'd `GEMINI_BACKEND=vertexai` that kept serving Studio would let an operator believe they had cut over. Fail closed, loudly. |
| Vertex **never** borrows `GEMINI_API_KEY` | Different credential, different billing account. A silent fallback surfaces as a confusing 401 mid-turn instead of a clear message at boot. |
| Errors name the var **and** the backend | "VERTEX_API_KEY is not set, and GEMINI_BACKEND=vertex. Set … or set GEMINI_BACKEND=studio to go back." Every failure says what to do next (hard rule 5). |

Callers wrap the throw back into their existing error type (`GeminiError`,
`SafetyGateError`) so route-level handling is unchanged.

### 3.2 DeepSeek (`providers/deepseek-{adapter,generation}.ts`, new)

Mirrors Moonshot exactly, minus the two shape differences in §2.5.

Catalog rows (`model-registry.ts`), prices best-effort 2026-08-12, **VERIFY
before enabling** — they affect order within a tier, never the safety gate:

| id | tier | in/out $/Mtok | safety |
|---|---|---|---|
| `deepseek-reasoner` | frontier | 0.55 / 2.19 | prompt-only |
| `deepseek-chat` | workhorse | 0.27 / 1.10 | prompt-only |

`deepseek-chat` undercuts every workhorse in the catalog, which makes it the
sharpest available test of whether price can beat the safety gate — R.29 asserts
it cannot.

### 3.3 The instrument (`scripts/check-model-backend.mjs`, new)

`npm run check:backend` — one real call, prints backend, model, key presence
(masked: `set (39 chars, …a1b2)`), reply, latency, usage. Uses Node's own
`--env-file`; it never parses or prints a secrets file itself. Covers all four
providers via `--provider`.

### 3.4 What did NOT change

`PERSONAS.default.safetySettings`, `GEN_CONFIG`, every model id, the chain
policy, the Sparks meter, any route. `gemini.safety-config.test.ts` is green and
untouched — deliberately. The owner's snippet sets all four harm categories to
`threshold="OFF"`; that is a **safety-posture change**, not a transport change,
and is explicitly **out of scope here** pending an explicit decision (§6).

---

## 4. Use Cases — all of them, and how we tackle each

1. **Nothing set (every box today).** `resolveBackend` returns `studio`;
   options are `{ apiKey }`, identical to the old two lines. DeepSeek rows are
   dropped by the key gate before the safety gate is even consulted. → GB.1,
   GB.4, R.26.
2. **Owner flips to Vertex.** `GEMINI_BACKEND=vertex` + `VERTEX_API_KEY`.
   Generation and the safety classifier both move; the chain still routes Google
   models because either key counts. → GB.5, R.30.
3. **Owner flips back.** Unset `GEMINI_BACKEND` (or set `studio`). No code,
   deploy, or model change — the reversibility the ask ("at will") requires.
4. **Flips to Vertex but forgets the key.** Boot-time throw naming
   `VERTEX_API_KEY`, `GEMINI_BACKEND=vertex`, and the way back. Never a silent
   Studio call on a box the operator believes is on Vertex. → GB.6, GB.8.
5. **Typo in the backend name.** Throws, listing the two legal values. → GB.3.
6. **Vertex-only box, Google chain.** Covered in §2.3 — the bug that would have
   emptied every chain. → R.30.
7. **Neither Google key set.** Google drops out of chains entirely, as before. →
   R.31.
8. **DeepSeek key set, flag unset.** Excluded — the common misconfiguration, and
   the one that must never silently lower the floor. → R.26.
9. **Flag set, DeepSeek key unset.** Excluded by the key gate, discovered at
   chain-build rather than mid-incident. → R.27.
10. **Both set.** DeepSeek becomes reachable, ordered by price within its tier
    like any other model. → R.28.
11. **DeepSeek pinned via `MODEL_FALLBACK_CHAIN` without the flag.** Still
    excluded — an explicit chain overrides ORDER, never the gates. → R.11 +
    R.26.
12. **`deepseek-reasoner` serves a game-build turn.** `reasoning_content` is
    dropped from the text stream; reasoning tokens are reported as
    `thoughtTokens` so the cost line stays honest. → DS.2, DS.3, DS.6.
13. **DeepSeek refuses (429 / quota / retired id).** Inherits the OpenAI
    taxonomy verbatim: rate-limit walks the chain, `insufficient_quota` throws
    (a billing failure must not be retried forever), 404 logs CHECK CONFIG. →
    DA.3.
14. **DeepSeek returns `content_filter`.** Normalized to `safety` — the runner
    treats it as a safety stop, and a safety block is never retried on another
    model (PRD-MODEL-FALLBACK §1). → DS.4.
15. **Operator wants proof before UAT.** `npm run check:backend` (any
    provider/backend/model), one real call, no app involved. → §3.3.
16. **Operator points `GEMINI_CHAT_MODEL` at an uncatalogued id** (e.g.
    `gemini-3.6-flash`, from the owner's snippet). `specFor()` misses, so the
    class falls back to the legacy Gemini-only ladder — working fallback, but
    NOT the cross-provider chain. Open item §6.3.

---

## 5. Scale ceilings & revisit triggers

- **Cost reconciliation.** Vertex bills through GCP; `MODEL_PRICING` still
  carries AI Studio rates, so a Vertex turn is priced at Studio rates in the
  admin dashboard. Same class as the known non-Gemini gap in
  `model-registry.ts`. **Revisit when:** Vertex serves real traffic for a full
  billing cycle, or Sparks margin needs to be trusted to the rupee.
- **Vertex quota.** Express mode has its own per-project quotas, unrelated to
  the AI Studio key's. **Revisit when:** the first 429 arrives from Vertex
  rather than Studio — the chain treats it as capacity and walks, which is
  correct but hides the quota signal.
- **Region/model availability.** Not every preview id lands on Vertex at the
  same time as AI Studio. **Revisit at:** every model-id change, by running
  `check:backend --model <id>` on both backends.
- **DeepSeek tiering.** `deepseek-reasoner` is tiered `frontier` on reputation,
  not on a measured game-build comparison. **Revisit before:** it ever serves a
  build turn — run `npm run eval:portability` first.

---

## 6. Open — owner decisions, not defaults

1. **Safety thresholds OFF.** The supplied snippet sets all four harm categories
   to `OFF`. Deliberately NOT implemented: it would convert Google from
   `provider-enforced` to `prompt-only` for the *primary* model on a children's
   product, dropping the middle of three layers and putting Gemini on the wrong
   side of the gate the registry exists to enforce. Options: keep as-is
   (recommended); OFF behind a flag for adult Studio creators only; OFF
   everywhere with the decision recorded here.
2. **Enabling DeepSeek for real traffic** needs BOTH the prompt-only posture
   decision AND the China data-handling review (`DATA_HANDLING.md`) — the same
   two Moonshot is still waiting on. Built ≠ enabled.
3. **`gemini-3.6-flash`** is not in `MODEL_CATALOG` (no verified prices, and a
   wrong price mis-ranks the whole tier). Setting it as the chat model works but
   silently drops to the legacy Gemini-only ladder. Give me verified pricing and
   it becomes a two-line catalog row.

---

## 7. Reproducing / verifying

```bash
npm test                                  # 2393 pass, 1 skipped (2026-08-12)
npm run typecheck
npm run check:backend                     # current .env
GEMINI_BACKEND=vertex npm run check:backend
npm run check:backend -- --provider deepseek
```

Test ids: `GB.1–GB.8` (backend switch), `DS.1–DS.6` (DeepSeek generation),
`DA.1–DA.3` (DeepSeek adapter), `R.25–R.31` (registry gates + Google credential).
