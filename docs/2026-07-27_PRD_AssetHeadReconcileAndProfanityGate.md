# PRD — Asset-Marker Head Reconciliation & Oversized-Turn Profanity Gate

Closes: KNOWN_BUGS.md #5 (residual) and #7/#12.
Written: 2026-07-27.

**Status update 2026-07-27 (implemented same day):**
- **Part 2 shipped as FIXED**, not the originally-proposed Fix A/B split below.
  The actual mechanism found on implementation: `ChatPanel.container.tsx`'s
  `apiMessage` construction (not a mid-`route.ts` concatenation) folded a text
  attachment's full content into `message` whenever it fell through
  `file-open.ts`'s complete-HTML-document check. Fix: attachment content now
  travels as its own `attachmentText`/`attachmentName` field; `route.ts`
  reconstructs the identical model-facing prompt but scans only the child's
  typed text. The `MAX_SCAN_CHARS` backstop shipped too, scoped to the
  SELF_HARM whole-string check specifically (`MAX_SELF_HARM_SCAN_CHARS=4000`
  in `safety.rules.ts`) per the owner's explicit decision: **don't scan
  attachment content at all** (not "scan both, bounded" — the middle option
  below was considered and rejected in favor of exclusion). See
  `BUG-FIX-LOG.md` 2026-07-27 and `KNOWN_BUGS.md` #7 (now FIXED).
- **Part 1 Step 0 (instrumentation) shipped.** `logSearchMiss` now logs
  `searchSpansHead`/`reconcileBailed=<reason>`. Step 1 (prod log collection)
  and the Step 4 structural-fix decision are still pending — see
  `KNOWN_BUGS.md` #5 (still WATCHING).

This PRD covers two independent, currently-open bugs. They share no code path
and can ship separately, but are grouped here because both were raised in the
same review pass. Each section is self-contained with its own Tech
Feasibility, Tech Plan, and Use Cases.

---

## Part 1 — Asset-Marker Head Reconciliation (KNOWN_BUGS #5 residual)

### Problem statement

`injectAssets` strips `USES_MODELS`/`USES_THREE`/`USES_AUDIO` markers from a
game's stored HTML and replaces them with an injected `<script
type="importmap">` + `window.AR_ASSETS=…` block inside `<head>`
(`src/lib/assets/inject.ts:112-124`, `runtime-helpers.ts:9-21`). On an edit
turn, the model doesn't see the injected `<head>` — it still writes markers
into its SEARCH block, per its system prompt. `reconcileAssetMarkers`
(`src/lib/game-edit.ts:180-186`) already rescues the common case: a SEARCH
block whose *only* mismatch is the marker comment itself.

The residual: when the model's SEARCH span happens to also cover the
`<head>` region (e.g. a contiguous rewrite from `<head>` through the marker
comment into `<body>`), the SEARCH text still contains the *original,
un-injected* `<head>` — no importmap, no `AR_ASSETS` — while the stored
source's `<head>` now contains those injected scripts. Stripping the marker
comment alone doesn't reconcile that structural divergence, so
`currentHtml.includes(strippedSearch)` still fails and the turn falls back
to full regeneration (expensive, and the trigger behind the 225s-timeout
cascade, BUG-FIX-LOG.md:355-386).

### Tech Feasibility

Confirmed root cause, confirmed fix candidates — no open unknowns beyond
**prevalence**, which the existing closeout plan (KNOWN_BUGS.md:18-52) is
designed to measure before committing to the structural fix. This PRD adopts
that plan as Step 0-1, and specifies the Step 3 structural fix precisely
enough to implement without further investigation:

- **Fix option A (preferred): patch against pre-injection source.** Store
  the raw, pre-`injectAssets` HTML alongside the delivered (injected) HTML
  on every asset-bearing game turn. Run `applyPatch` against the raw copy
  (which still has markers and an un-injected `<head>`, matching what the
  model sees), then run `injectAssets` on the *patched* result before
  storing/delivering. This makes `injectAssets` idempotent-adjacent by
  construction — the model always patches against exactly what it was shown.
  Cost: one extra HTML field in the stored game record; `injectAssets` must
  already be safe to re-run (it should be, since it's already applied fresh
  each generation).
- **Fix option B (fallback, higher risk): make `injectAssets` reversible.**
  Add a `stripInjectedHead()` inverse that removes the importmap/`AR_ASSETS`
  script tags it added, so `reconcileAssetMarkers` can normalize the stored
  source's `<head>` back to un-injected form before the `includes()` check.
  Riskier because it requires the strip to be byte-exact for every shape
  `insertEarly` can produce (after `<head>`, after `<html>`, or prepended),
  and any drift silently reintroduces the bug.

Recommendation: **Option A.** It sidesteps the byte-exact-inverse risk
entirely and mirrors the existing pattern (`currentGameHtml()` already
stores an artifact field distinct from display text).

### Tech Plan

1. **Step 0 (instrumentation, no behavior change).** Add `searchSpansHead`
   and `reconcileBailed=<reason>` (`not-injected` | `new-asset` | `no-marker`)
   to `logSearchMiss` in `route.ts`, per the existing closeout plan.
2. **Step 1 (measure).** Deploy; after a representative UAT window, grep
   prod logs (`ec2-3-110-44-237:logs/app.log`) for
   `afterMarkerStrip=false searchSpansHead=true` counts.
3. **Decision gate.** If that combination is rare (<10% of asset-edit
   turns), close #5 as "accepted residual, falls back to regeneration" and
   stop here — regeneration is correct-but-slow, not broken. If common,
   proceed to Step 4.
4. **Step 4 (structural fix, Option A).**
   - Add `rawHtml` (pre-injection) to the game record alongside the existing
     delivered HTML.
   - On generation/injection, persist both: `rawHtml` = model output before
     `injectAssets`; delivered = `injectAssets(rawHtml)`.
   - On edit: run `applyPatch(rawHtml, patch)`, not
     `applyPatch(deliveredHtml, patch)`; on success, re-run
     `injectAssets(patchedRawHtml)` to produce the new delivered HTML; store
     both.
   - `reconcileAssetMarkers` becomes unnecessary for this path (kept for
     any turn where `rawHtml` is missing on old records — migration
     safety) but is no longer load-bearing.
   - Backfill: old records without `rawHtml` fall back to today's behavior
     (best-effort reconcile, then regenerate) — no migration required,
     this degrades gracefully.
5. **Tests (test-first per repo convention):**
   - Regression test reproducing the exact residual: a SEARCH block
     spanning `<head>` (with un-injected content) through a real edit
     target, asserting it now applies via `rawHtml` instead of falling to
     `search_not_found` → regeneration.
   - Existing `game-edit.reconcile.test.ts` (A.1-A.7) and `markers.test.ts`
     (M.1-M.9) must continue passing unchanged.
   - New test: `injectAssets(rawHtml)` re-run twice on the same `rawHtml`
     produces byte-identical output (idempotency of the injection step
     itself, since Option A depends on it being safe to re-run per edit).

### Use Cases

- **Kid edits a 3D game with "make the car faster" and the diff happens to
  touch code near the top of the file.** Today: forced regeneration (slow,
  risk of unrelated drift). After fix: patches against `rawHtml`, applies
  cleanly, `injectAssets` re-run, no regeneration.
- **Kid edits a game generated before this fix ships (no `rawHtml` stored).**
  Falls back to today's behavior — `reconcileAssetMarkers` best-effort, then
  regeneration if it still misses. No regression, no crash.
- **A future marker type is added (e.g. `USES_PARTICLES`).** `rawHtml` still
  has it as a live marker pre-injection; `applyPatch` against `rawHtml`
  works the same way with no special-casing per marker type — the fix
  generalizes without touching `markers.ts`.
- **Prevalence turns out to be low (Step 1 shows <10%).** Ship Steps 0-1
  only, close #5 as "regeneration fallback is the accepted behavior for a
  rare case," and skip the storage-schema change — avoids over-engineering
  for a tail case.

---

## Part 2 — Oversized-Turn Profanity Gate (KNOWN_BUGS #7 / #12)

### Problem statement

`RulesClassifier.classifySync` (`src/lib/safety.rules.ts`) is a
deterministic, app-side, pre-generation input gate — distinct from Gemini's
own provider-side `SAFETY` verdict (KNOWN_BUGS #11, already fixed via
`CHILD_BUILDER_CONTEXT`, which does nothing for this bug). It runs on every
incoming chat message with **no size bound**: `SELF_HARM` terms are matched
as a whole-message substring after stripping all whitespace (`normalize()`,
`:11-21`), and `PROFANITY` terms are matched per whitespace-token
(`normalizeToken`/`collapseSpelledOutLetters`, `:25-59`). Edit turns resend
the *entire game* as the chat message (`route.ts:345`) — up to ~100K chars
of minified HTML/JS/CSS. At that volume, the odds of an accidental substring
or token match rise sharply (same class as the already-fixed "medic kit" →
"medickit" false positive, 2026-07-18, but ~100x the text volume). A
confirmed real hit: `chars=100403`, `hard_block` in 29ms, no meaningful
`triggerText` — "just game source."

### Tech Feasibility

Confirmed, deterministic, fully reproducible root cause — no unknowns. Two
complementary fixes, both low-risk and independently shippable:

- **Fix A: don't scan generated game source as if it were child speech.**
  The actual child-authored text in an edit turn is the short instruction
  ("make the car faster"); the ~100K chars is the app's own re-sent game
  state, not something the kid typed. The safety gate's job is to screen
  *child input*, not the app's own round-tripped payload. Fix: scan only
  the child-authored portion of the message (the instruction/prompt part),
  not the appended game source, wherever the two are structurally
  distinguishable in the turn payload.
- **Fix B: bound the scan regardless.** As defense in depth (in case
  instruction/source aren't cleanly separable everywhere), cap
  `classifySync`'s input at a reasonable ceiling (e.g. 4K chars) for the
  SELF_HARM whole-string check specifically, since that's the unbounded
  one — PROFANITY is already per-token and structurally safer, though
  still worth capping token count scanned as a hard ceiling.

Recommendation: **ship both.** Fix A addresses the actual product bug (the
gate is answering the wrong question); Fix B is a cheap backstop so no
future oversized-payload path (e.g. a large upload, a pasted document)
reintroduces the same class of false positive.

### Tech Plan

1. **Locate the structural split** between child-authored instruction and
   appended game source in the edit-turn message construction (wherever
   `route.ts` assembles the message sent to `classifySync` at `:345`).
   If today they're concatenated into one opaque string before the safety
   check runs, that's the actual defect — the fix is to run
   `classifySync` on the instruction segment only, before concatenation.
2. **If no clean split exists yet:** introduce one — the edit-turn payload
   already must know its instruction text and its game-source text
   separately upstream (they're templated together), so thread the
   instruction text through untouched for the safety check specifically.
3. **Add Fix B as a ceiling** inside `safety.rules.ts` itself: bound the
   whole-message SELF_HARM substring scan to the first N chars after
   normalization (child instructions are never legitimately tens of
   thousands of characters), independent of whether Fix A's split is
   perfectly clean everywhere.
4. **Tests (test-first):**
   - Regression test: reproduce the exact reported case — a 100K+ char
     edit turn containing a short benign instruction plus real (non-toxic)
     minified game HTML — assert it no longer `hard_block`s.
   - Existing safety test suite (whatever covers "medic kit" and other
     known-good false-positive fixes) must keep passing unchanged.
   - New test: a message that IS genuinely long child-authored text (edge
     case — a kid pastes a long story) still gets scanned correctly up to
     the Fix B ceiling, not silently skipped entirely.
   - New test: an actual self-harm or profanity phrase embedded inside a
     100K-char edit-turn payload still gets caught if it appears in the
     instruction segment (Fix A doesn't create a bypass by scanning less).

### Use Cases

- **Kid asks "make the battle game more exciting" as an edit on an existing
  ~100K-char game.** Today: hard-blocked, no explanation, "tangled me up."
  After fix: instruction segment scanned (clean), turn proceeds normally.
- **Kid actually types something the profanity/self-harm gate should catch,
  inside a normal-length new message.** Unaffected — Fix A only changes
  *which segment* of an edit turn is scanned, Fix B's ceiling is far above
  any real child message length; detection sensitivity for genuine
  first-turn or short messages is unchanged.
- **A kid pastes a large block of text as the instruction itself (not game
  source) — e.g. copies a long story and asks to build a game from it.**
  Must not silently bypass the gate. Covered by the Fix B ceiling test
  above; if this segment can legitimately exceed the ceiling, the ceiling
  is applied with a truncation-not-skip policy (scan first N chars) rather
  than exempting long messages outright.
- **Some other future path sends a large payload through the same gate**
  (e.g. a bulk import feature). Fix B's ceiling protects it automatically
  without needing every future caller to know to segment its input first.

---

## Rollout

Both parts are independently flaggable and revertible; neither touches a
shared code path, so they can ship in either order. Recommended order:
Part 2 first (smaller, no schema change, actively blocking kids today per
KNOWN_BUGS #7 being open since 2026-07-27), then Part 1 Step 0-1
(instrumentation only) to gather real prevalence data before committing to
the Part 1 structural fix.
