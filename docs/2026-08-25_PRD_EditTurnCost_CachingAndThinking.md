# PRD — Edit-turn cost: make the cache hit (A) and bound thinking (B)

2026-08-25 · Status: **BUILT + MEASURED locally (§10) — not deployed.** A+B
shipped as designed; the measured saving came from A.2b (the model view),
found during measurement. Owner decisions in §7 still open (ship order is
now moot — everything is in one change).
Owner: Ashok. Author context: the 2026-08-25 spend-cap incident and the
production usage analysis that followed (numbers in §2, all from the prod
`usage_events` table and `logs/app.log`, aggregate only).

Companion docs: `PRD-PROMPT-CACHING.md` (the byte-level plan this PRD
*ships*, unchanged in substance), `COST_TOKEN_BUDGET.md` (waste ledger),
`PRD-RESILIENT-GENERATION.md` (edit-turn patch contract — untouched here),
`PROMPT_MANAGEMENT.md`, platform `TECH_DEBT.md`.

---

## 0. One-paragraph summary

Edit turns already ship as SEARCH/REPLACE patches (95% clean-apply rate in
prod since 2026-08-17), so their *output* is small. What they still pay for
is (1) re-reading the whole game at the full input rate every turn because
the prompt prefix is never byte-stable, and (2) 2–4× more thinking tokens
than the configured 1,024 budget on the 3.6/3.7-flash line. This PRD ships
two independent changes — **A: stable prefix so implicit caching hits** and
**B: an edit-turn-specific, verified thinking budget** — with a measured
target of **−45–55% per edit turn** (≈ $0.034 → $0.016) and no change to
what the child sees. Neither change touches patch application, safety
settings, the fallback chain, or storage.

## 1. Why now

- The GCP spend cap tripped at 02:11 UTC on 2026-08-25 and every build has
  failed since. Whatever the cap is set to, per-turn cost is the only lever
  that is ours.
- The 3.6/3.7-flash promo rate **doubles on 2027-01-01** (TECH_DEBT #107).
  Every waste token doubles with it.
- Sparks are a fixed multiple of metered ₹ (`spark-cost.ts`). Cheaper turns
  are automatically more turns per pack for every kid.

## 2. Baseline — measured 2026-08-25 (prod, `kind=chat`, 3.6/3.7-flash, 2026-08-18 → 25)

| Component of one edit turn | Avg tokens | Rate ($/MTok) | Cost | Share |
|---|---|---|---|---|
| Prompt **uncached** (system + full game + window) | 12k–28k (billedPrompt) | 0.75 | $0.009–0.021 | **~45%** |
| Prompt cached | 0.3k–0.7k | 0.075 | ~$0.00005 | ~0% |
| Thinking | **2.1k–3.8k** (budget says 1,024) | 3.75 | $0.008–0.014 | ~35% |
| Output (patch hunks + prose) | 1.5k–3k | 3.75 | $0.006–0.011 | ~20% |
| **Turn** | | | **$0.030–0.038** | |

Supporting facts:

- **Cache hit rate: 2–4%** of billed prompt (identical to the ~4% baseline
  `PRD-PROMPT-CACHING.md` §2 measured on 2026-07-25 on the old model; the
  three killers in that PRD §3 are unchanged in code today).
- **Edit turns are patches:** 153 edit turns since 08-17 → 130 `✓ edit
  patch` + 15 `✓ edit patch (cheap strict rung)` = **145 clean (95%)**, 5
  soft-fails (game untouched), 3 full regenerations. `applyPatch` works.
- **Thinking exceeds budget:** per-day avg thinking on 3.6-flash 2,131–3,777;
  on 3.7-flash 1,139–2,912. Old primary (3-flash-preview) sat at ~1,500.
  `builder-mode.ts:13 DEFAULT_THINKING_BUDGET = 1024`.
- **Not a pricing bug (any more):** implied output rate from stored `costUsd`
  is exactly $3.75/M from 2026-08-18. (2026-08-17 only: $11.87/M implied —
  3.6-flash was served before it was in `MODEL_CATALOG`, so
  `FALLBACK_PRICE` $1.5/$9 metered 59 turns at ~3× true cost; see §9.)

## 3. Goals / non-goals

**Goals**
- G1 Prod cached% on the primary model ≥ 25% of billed prompt tokens
  (threshold inherited verbatim from `PRD-PROMPT-CACHING.md` §5.4).
- G2 Edit-turn avg thinking ≤ 1.2× the configured edit budget (i.e. the
  budget is *honoured*), with the budget itself set by measurement (§5).
- G3 Patch clean-apply rate stays ≥ 90% (currently 95%) and golden-prompt
  visual UAT shows no quality drift.
- G4 Nothing the child sees changes: same prose, same preview, same chips.

**Non-goals**
- Multi-file game architecture (see §8 — a later, larger change that A makes
  mostly unnecessary).
- Explicit `CachedContent` / paid cache storage — escalation only (§4.A.4).
- Reducing *build*-turn output (10–20k tokens; that is the product working).
- Any change to `applyPatch`, soft-fail-on-edit (owner decision 2026-08-10),
  safety thresholds, hedging, or the fallback chain.

## 4. Design

### A — Byte-stable prefix so implicit caching hits

**A.1 Ship `PRD-PROMPT-CACHING.md` Fixes A + B + C as written.** That PRD is
complete and still accurate; this PRD does not restate it. In one line each:

| Fix | Change | Kills |
|---|---|---|
| A | Hysteresis window (cut in blocks, not slide-by-one) — `history-trim.ts` | killer #1: every turn shifts every history byte |
| B | Game source rides the **tail** (final user message) from `currentGameHtml(history, pin)`; all history game messages become a never-rewritten placeholder | killer #2: the 12–25k mutating blob mid-prefix |
| C | `GAME_EDIT_PROMPT_SECTION` / `REPEATED_REQUEST_SECTION` move out of `systemInstruction` to the tail; monotonic catalog sections reordered largest/earliest-first | per-turn bytes at the very front of the prompt |

**A.2 Additions since that PRD was written (must ride the same commits):**

- `NEXT_ASK_EDIT_PROMPT_SECTION` (kid hints, 2026-07-28) is also per-turn
  (`nextAsk` flag in `configFor`, `gemini.ts:753`). Same treatment as Fix C:
  tail, not instruction. Pin in `gemini.prompt.test.ts`.
- Save-state / published-save playbooks (`gates.save`, 2026-08-01) are
  monotonic gates — they stay in the instruction, slotted by the Fix C
  ordering rule (~880 tokens; between THREE+models and MULTIPLAYER).
- `CHILD_BUILDER_CONTEXT` / report-context lines (2026-07-27, 08-05) already
  ride the user turn — unchanged, but the prompt-contract test must pin their
  position *after* the game block so they don't split it.
- **Fallback-model turns are excluded from G1** (a hedge loser hits a cold
  cache by definition — `PRD-PROMPT-CACHING.md` §2).

**A.3 Re-verify the caching rule on the 3.6/3.7 line before coding.** The
existing PRD's rules (prefix = systemInstruction → history → tail; ≥1–2k
minimum; minutes-scale TTL) were verified on 3-flash-preview. Step 0 of
implementation is a 4-request live probe (same prefix ×2 within 60s, then
one byte changed at the front, then at the tail) reading
`cachedContentTokenCount` — logged into `logs/model-decisions.jsonl` and
pasted into this PRD's §10. If 3.6/3.7 implicit caching behaves differently
(different minimum, no cross-request hit), the plan is re-cut before any
history-trim code moves.

**A.2b — FOUND DURING MEASUREMENT (2026-08-25): the model re-reads our own
injected runtime on every edit.** The stored game is the *delivered* document:
the child's ~12k chars plus ~35k chars delivery injects (`loadModel` helper
module 17.8k, WebGL guard 7.6k, perf probe 6.8k, frame governor, AR_* tables,
import map, canvas-floor style). That is ~10k tokens of byte-identical
boilerplate per edit turn — ~60% of the prompt — at the full input rate,
never cached (it sits inside the mutating game block). Shipped as
`src/lib/assets/model-view.ts` `modelViewOf()`: the tail block carries the
game minus exactly what injection adds (same signatures the injectors use to
recognise their own blocks), while `applyPatch` keeps running against the
delivered document — every line the child wrote exists verbatim in both
(`model-view.test.ts` MV.3). A SEARCH that spanned the `<head>` injection
seam would soft-fail like any other miss; the edit prompt already tells the
model to anchor on landmark comments. This is the lever the original A
forecast attributed to caching; see §10 for the measured split.

**A.5 — Edit-sized instruction (plan "noble-orbiting-stallman", owner decisions
2026-08-25).** After A.2b the system instruction (~7.7k tokens on a 3D+save edit)
was the largest block left. Three changes, build turns unchanged in wording:
(1) the sports playbook (~1,000 tok) is gated on the game (`gates.sports`), not
the manifest; (2) the save playbooks are a build-turn gate — on an edit they
ride only when the ask names saving/progress (`editGates`); (3) edit turns get
`CHILD_SAFETY_CORE` + `EDIT_CRAFT_RULES` + `THREE_EDIT_CHEATSHEET` + the edit
contract instead of the build prompt and the 3D/physics/catalog stack, with a
full section returning only when the ask names that subsystem. Owner-verified
split of the base prompt: ~160 tok safety/tone (kept on every shape, rule 3),
~1,290 tok build craft (build turns only). Measured (chars/4): 3D edit
instruction 7.7k → 1.2k; build 3D+save 7.7k → 6.8k. Rollback:
`EDIT_INSTRUCTION_V2=off`.

**A.4 Escalation — explicit `CachedContent` — only if A.1 lands < 10%.**
(Post-measurement note: the implicit cache plateaued at the instruction on
every run; the game block is uncacheable in the tail. If A.4 is ever built it
is the *only* way the child's code itself reaches the cached rate.)
Create a cache of `[systemInstruction + game source]` on each build/patch
result, TTL 30 min, keyed by artifact hash on `turn_results`; edit turns
reference it. Costs storage ($/MTok-hour) and lifecycle code (create,
refresh, delete on rewind). Decision deferred to the §5.4 measurement; not
designed further here.

### B — Edit-turn thinking budget, verified to reach the model

**B.1 Find out why 1,024 isn't holding — before changing the number.**
Three hypotheses, each with a one-line check; the fix depends on which is
true:

| # | Hypothesis | Check | Fix if true |
|---|---|---|---|
| H1 | Box `.env` sets `GEMINI_BUILDER_THINKING_BUDGET` above 1,024 | Owner reads the box `.env` (not Claude — hard stop) | none needed; move to B.2 |
| H2 | 3.6/3.7-flash ignore `thinkingConfig.thinkingBudget` and want the newer `thinkingLevel` (`low/medium/high`) field | Live probe: same edit prompt with `thinkingBudget: 256` vs `thinkingLevel: "low"`; compare `thoughtsTokenCount` | add per-model thinking config in `model-registry.ts` (`thinkingStyle: "budget" \| "level"`), `builderGenOverrides` emits the right shape |
| H3 | Budget is honoured but is a *soft* target on this line (overshoot ~2–3×) | Same probe, 3 budgets (256 / 512 / 1024), plot actual vs requested | treat requested budget as `target / overshoot` and pin the ratio in a test + this doc |

**B.2 Give edit turns their own budget.** `builderGenOverrides(env,
{isEdit})` returns a smaller thinking allowance on edit turns
(`GEMINI_EDIT_THINKING_BUDGET`, default **512**) and keeps the build value
for fresh builds. Rationale: a patch is 1–3k output against a source the
model is reading verbatim; the prod strict-retry rung already runs with a
*halved* budget (`withReducedThinkingBudget`) and rescues 15/153 turns, so a
low budget demonstrably still patches. `isEdit` is already computed in
`configFor` (`gemini.ts:739`); no new predicate.

**B.3 Guardrail.** `model-runner.ts` MAX_TOKENS retry (halve thinking) is
unchanged. If the golden run shows patch clean-apply < 90% at 512, step to
768, then stop: B is not allowed to trade quality for cost (G3).

### What A and B share

- Both are measured with the two columns the meter already stores:
  `cachedTokens / billedPromptTokens` and `thoughtTokens` per row. No new
  telemetry; one new admin usage-tab column ("cached %", "think avg") on
  the Platform `/studio/admin` bridge is a nice-to-have, not a dependency.
- Both are env-flagged for instant rollback: `PROMPT_PREFIX_V2=off`
  (restores today's trim/instruction shape) and `GEMINI_EDIT_THINKING_BUDGET`
  unset (edit turns fall back to the build budget).

## 5. Savings arithmetic (per edit turn, 3.7-flash, promo rate)

| | Today | After A (25% cached, conservative) | After A (40%) | After A+B (40%, think 600) |
|---|---|---|---|---|
| Prompt uncached 20k → | $0.0150 | 15k · 0.75 = $0.0113 | 12k = $0.0090 | $0.0090 |
| Prompt cached | ~0 | 5k · 0.075 = $0.0004 | 8k = $0.0006 | $0.0006 |
| Thinking 2,800 → | $0.0105 | $0.0105 | $0.0105 | 600 · 3.75 = $0.0023 |
| Output 2,200 | $0.0083 | $0.0083 | $0.0083 | $0.0083 |
| **Turn** | **$0.034** | $0.031 (−9%) | $0.028 (−17%) | **$0.020 (−41%)** |

At the doubled 2027 rate the same turn is $0.068 today → $0.040 after. On
the Aug-17→25 mix (~20 edit turns/day) that is ~$0.28/day now — small in
absolute terms; the point is the *per-game* floor before marketing volume
multiplies it (`COST_TOKEN_BUDGET.md` triggers). B is the larger and cheaper
win; A is the structural one and the one the 2027 repricing punishes most.

Honest caveat: A's cached% ceiling is bounded by TTL (kids pause) and by
the game block itself, which sits in the tail and is **never** cached under
implicit caching. That is why A.4 exists.

### 5.4 Acceptance (fixed now, per `PRD-PROMPT-CACHING.md` §5.4 — not re-arguable)

| Metric (prod, primary model, ≥3 real sessions ≥10 turns, post-deploy) | Ship | Investigate | Roll back |
|---|---|---|---|
| A — cached% of billed prompt | ≥ 25% | 10–25% | < 10% → A.4 decision |
| B — edit-turn avg `thoughtTokens` / configured budget | ≤ 1.2× | 1.2–2× | > 2× (budget not honoured — back to B.1) |
| G3 — edit patch clean-apply (log `✓ edit patch*` / `edit turn:`) | ≥ 90% | 85–90% | < 85% |
| UAT — golden-prompt visual pass | no drift | any single regression fixed-forward same day | else |

## 6. Testing (test-first; the suite exists — these are the additions)

Written **before** the code changes, per repo rule 2:

- `history-trim.test.ts` — hysteresis window cut points; placeholder never
  rewritten; game block absent from history on every turn; pinned rewind
  still resolves via `currentGameHtml`.
- `gemini.contents.test.ts` — request shape byte-pinned: `[instruction][hist]
  [tail = game block → edit section → next-ask section → builder context →
  child's message]`; order is the contract.
- `gemini.prompt.test.ts` — **"instruction bytes identical across two
  consecutive edit turns with the same gates"**; `modelsPromptSection()` /
  `audioPromptSection()` determinism pin (two calls, same bytes).
- `builder-mode.test.ts` — edit turn gets `GEMINI_EDIT_THINKING_BUDGET`
  (default 512), build turn keeps the build budget; env override; the
  per-model thinking shape from B.1 if H2 holds.
- Route edit-branch integration — `applyPatch` still runs against
  `currentGameHtml`, soft-fail unchanged; a fixture where the child's message
  contains a ```` ```html ```` fence must not be mistaken for the game block
  (the tail now holds both).
- **The gap, not the happy path:** a fixture with the game *absent* from
  history and present only on the tail (the new normal) and one with the
  pin set to a non-newest message.

Instruments (no owner UAT until these pass — rule 12):

1. A.3 live cache probe (4 requests, dev credentials) — result pasted in §10.
2. B.1 thinking probe (3 budgets × 2 shapes) — result pasted in §10.
3. `node scripts/golden-prompts.mjs` full set + `verify-game-html.mjs`
   before/after, on 3.7-flash; the 20-min golden-session script in
   `PRD-PROMPT-CACHING.md` §6.2 for the multi-turn cache read.
4. `scripts/harness-preview.mjs` screenshots of one edited game before/after
   (visual pass, rule 9).

## 7. Decisions needed from the owner (no clear winner — asking, not picking)

1. **Ship order.** Recommendation: **B first** (one file, one env var, a
   probe, ~half the saving), then A (history-trim + prompt contract,
   ~a day plus UAT). Alternative: A first because it is the structural fix.
2. **Edit thinking default:** 512 (recommended, backed by the strict-retry
   evidence) vs 768 (safer for 3D/physics edits) — golden run decides
   between them, but the *starting* value is a call.
3. **A.4 explicit cache:** pre-authorise as the automatic next step if A lands
   < 10%, or require a separate decision then. Recommendation: separate
   decision (it adds paid storage).
4. **2026-08-17 Sparks over-debit** (§9): credit the affected turns, or note
   and move on. Not part of this PRD's code; needs a yes/no.

## 8. What this does NOT do, and the ceilings

- **Multi-file architecture** would let an edit turn send only the touched
  file (input ↓ further) — but after A the residual input cost is
  ~$0.009/turn, and multi-file touches artifact storage, preview loader,
  save/continue, published-save, share, repair, history-trim, and adds a
  cross-file consistency failure class. Revisit only if A.4 is also
  insufficient *and* games grow past ~40k tokens.
- **Floor after A+B ≈ $0.02/edit** (patch output + residual input). Below
  that you are paying for the patch itself.
- **Build turns** (10–20k output, ~$0.05–0.08) are untouched and remain the
  unit-economics floor per game.
- **TTL** — a kid who pauses >~10 min returns cold; not fixable without A.4.
- **Scale triggers:** re-run §2 on marketing volume; re-run §5 on
  2026-12-15 (TECH_DEBT #107 repricing).

## 9. Adjacent finding — 2026-08-17 metering/Sparks incident (not this PRD's code)

3.6-flash served 59 chat turns on 2026-08-17 before it existed in
`MODEL_CATALOG`; `estimateCostUsd` priced them at `FALLBACK_PRICE` ($1.5/$9)
— metered $4.07 vs ~$1.9 true. Because Sparks debit from metered ₹, those
kids were charged ~2–3× for that day's edits. Fixed as a side effect of the
2026-08-18 deploy (catalog entry added); the residual is (a) the
over-debited balances (owner decision §7.4) and (b) a guard so a
`FALLBACK_PRICE` hit on the *primary* model logs at `warn` and is visible on
the admin usage tab — small follow-up, own BUG_LOG entry.

## 10. Measurement log — 2026-08-25, local dev against the REAL models

Instruments: `scripts/replay-session.mjs` on `golden/sessions/physics-world.json`
(build → 5 edits → rewind-pinned edit → 4-min pause → edit; synthetic, no child
data), dev server started with `EXPOSE_TURN_USAGE=1 GEMINI_BACKEND=vertex
GEMINI_CHAT_MODEL=gemini-3.7-flash` (prod's backend + model);
`scripts/probe-thinking.mjs` on Vertex 3.7-flash, 3 reps per config, streaming.
Raw runs: `golden/runs/sessions/physics-world.{before,before-37,after-37,after2-37}.json`.

### 10.1 Thinking probe (B.1) — H2/H3 refuted; the budget IS honoured from this code

| thinkingConfig on 3.7-flash (Vertex) | avg thoughts | avg output | avg ms | patch |
|---|---|---|---|---|
| budget 256 | 0 | 1,227 | 10.1s | 3/3 |
| budget 512 | 0 | 1,029 | 7.9s | 3/3 |
| budget 1024 | 154 | 1,239 | 12.5s | 3/3 |
| budget 1024, no summaries | 0 | 1,031 | 8.0s | 3/3 |
| level LOW | 0 | 873 | 6.9s | 3/3 |
| budget 0 | 0 | 865 | 7.7s | 3/3 |
| **budget −1 (dynamic)** | **3,313** | 779 | **25.8s** | **2/3** |
| **no thinkingConfig** | **1,195** | 1,350 | **22.3s** | 3/3 |

`MINIMAL` is rejected by 3.7-flash (400). Through the real route on Vertex the
edit turns thought 0–265 tokens. Prod's 2–4k/edit therefore matches the
*unbounded* rows → **H1: the box `.env` is overriding
`GEMINI_BUILDER_THINKING_BUDGET`** (owner to check; Claude may not read it).
`GEMINI_EDIT_THINKING_BUDGET` (default 512) bounds edit turns in prod
regardless of that value. One after-run edit turn reached 1,317 thoughts on a
512 budget — the budget is a target, not a hard clamp (soft overshoot exists;
rare).

### 10.2 Replay — same session, prod-like backend/model

| run | what | session $ | $/edit | prompt tok/edit | cached % | edit think avg | patched |
|---|---|---|---|---|---|---|---|
| before-37 | code as deployed | $0.1457 | $0.0170 | ~24.4k | 22% | 16 | 7/7 |
| after-37 | A (stable prefix) + B (edit budget) | $0.1644 | $0.0198 | ~24.4k | 18% | 225 | 7/7 |
| after2-37 | A + B + A.2b model view | $0.1071 | $0.0119 | ~14.3k | 30% | 38 | 7/7 |
| **after3-37** | **+ A.5 edit-sized instruction, sports/save gating** | **$0.0865** | **$0.0092** | **~7.1k** | 0% | 53 | **7/7** |

Cumulative vs before-37: **$/edit −46%, prompt tokens/edit −71%, session −41%**,
7/7 patches on every run. Browser verification (`scripts/verify-game-html.mjs`,
playwright-core installed 2026-08-25): after2 3/3 and after3 4/4 games run
clean (canvas drawn, no runtime errors, loadModel helper v9 + assets resolved).
after3 cached 0% is expected — the instruction is now ~1.2k tokens, under the
implicit cache's useful minimum; there is nothing large and stable left to cache.

Reading it honestly:

- **A alone moved nothing measurable.** The implicit cache hit is a flat
  ~8.16k plateau (instruction + short history) in every run; the game block
  is never cached in either layout (it sits in the mutating tail — position-
  sensitive, per PRD-PROMPT-CACHING §1) and it *is* the prompt. On an 8-turn
  session the history A protects is ~1k tokens. A stays because it costs
  nothing, is the precondition for A.4, and its value grows with session
  length; its G1 threshold (≥25% cached in prod) is **not** claimed from
  this run — 30% here is the model-view shrinking the denominator.
- **Output-token noise dominates run-to-run $**: identical prompts produced
  235–2,659 output tokens across runs. Compare *prompt* tokens for A/A.2b
  and *thought* tokens for B; treat $/edit as ±20%.
- **The savings are A.2b and A.5** (A.2b: 24.4k → 14.3k; A.5: 14.3k → 7.1k): prompt per edit 24.4k → 14.3k (−41%), $/edit
  −30%, session −27%, with 7/7 patches still applying clean and the rewind
  pin still resolving. Remaining prompt on an edit ≈ 8k instruction (cached
  when it hits) + ~5k child's code + ask.
- Baseline on the default local setup (AI Studio, `gemini-3-flash-preview`):
  $0.0881/session, $0.0106/edit, 19% cached — recorded for reference; no
  after-run on that backend (prod is Vertex).

### 10.3 What was NOT verified here

- No browser run of the produced games: `scripts/verify-game-html.mjs` needs
  `playwright-core`, which is not installed in this checkout. The 8 saved
  `*.html` under `golden/runs/sessions/` are ready for it. Patches applied
  and the model reported clean edits, but "runs in a browser" is unproven.
- Prod cached% / clean-apply after deploy — §5.4 acceptance still applies.
- The box `.env` thinking value (H1) — owner.

## 11. Docs that ship## 11. Docs that ship with the code (rule 5)

`PRD-PROMPT-CACHING.md` status → SHIPPED with a pointer here;
`COST_TOKEN_BUDGET.md` token-flow table (thinking row, cache row) and
model-chain note; `PROMPT_MANAGEMENT.md` (new request shape);
`docs/ARCHITECTURE.md` (prompt assembly); `FEATURES.md` one-liner;
`.env.example` (`GEMINI_EDIT_THINKING_BUDGET`, `PROMPT_PREFIX_V2`); platform
`TECH_DEBT.md` (A.4 deferred, multi-file deferred, primary-on-FALLBACK_PRICE
guard); `BUG_LOG.md` for §9.
