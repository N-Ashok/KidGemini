# PRD — Resilient Generation: stop discarding good answers (decision doc)

2026-07-20 · Status: **Option 3 SHIPPED** (owner decision same day: "60s + keeping
the results of the 1st call"). Options 4/5/6 still proposed — see §4.
Trigger: owner observation on the 225s incidents (`BUG-FIX-LOG.md` 2026-07-20):

> "it is not the loss that i am worried. we are changing the whole script and
> regenerating… the first call must have given an answer by the time we went to
> the third call, then we should have used the first one which is much better
> quality. all these are wasted opportunity and resource."

That is the correct diagnosis. The timeout fix already shipped stops the
*failure*; it does not stop the *waste*. This doc is about the waste.

---

## 1. Three distinct problems, currently conflated

| # | Problem | What it costs | Where it lives |
|---|---|---|---|
| **P1** | **Abandonment.** `withTimeout` is a `Promise.race` with no cancellation, so an in-flight generation is dropped, not stopped. It completes, resolves into nothing, and bills. | Up to 6 complete generations per incident, none recorded (`recordUsage` runs on success only → invisible spend) | `retry.ts`, `gemini.ts` one-shot path |
| **P2** | **Quality inversion.** The chain is strictly serial. The *primary* (best model) is abandoned at the deadline; by the time the *lite* model answers, the primary's better answer has almost certainly already landed unheard. We then serve the worst output we generated. | The child gets a measurably worse game than one we already paid to produce | `model-runner.ts` chain walk |
| **P3** | **Whole-script regeneration.** A failed edit patch escalates to rebuilding the ENTIRE game (24576 tokens, 30–46s). Patches exist precisely because a regeneration can silently regress parts the child never asked to change. | Slow, expensive, and risks losing work the child liked | `api/chat/route.ts` patch-fallback path |

**P3 is upstream of the other two.** Every logged incident began with
`patch failed (search_not_found) … inSource=false`. Fix P3 and most P1/P2
occurrences never happen.

## 2. What "properly" looks like

The current model is **serial-abandon-degrade**: try, give up, discard, try
something worse. The target model is **overlap-and-prefer**: overlap attempts,
never discard, serve the best answer that arrives inside the child's patience.

Two independent levers:

- **Never discard** — an attempt that is still running is an asset, not a
  liability. Either let it finish and use it, or cancel it so it stops billing.
  Doing neither (today) is the worst of both.
- **Prefer quality, not arrival order** — when several answers land, serve the
  highest-tier one, not the first. The existing stream hedge commits on *first
  token*, which is a latency rule, not a quality rule.

## 3. Options

| # | Option | How it works | Advantages | Disadvantages | Risk mitigation |
|---|---|---|---|---|---|
| **1** | **Longer deadline only** *(shipped today)* | Build turns get 120s instead of 30s | Trivial; already done; removes the deterministic failure | Still serial — a genuinely dead primary makes the child wait 120s before anything else starts. Still discards on eventual timeout | Keep as the floor under every other option. Tune via `GEMINI_BUILD_TIMEOUT_MS` against real turns |
| **2** | **Cancel on give-up** | Pass an `AbortSignal`; abandoning actually stops generation | Stops invisible billing; honest resource use | Throws away work that was nearly done — fixes P1's cost but makes P2 *worse* | Only cancel once another attempt has definitively won; never cancel the highest-tier attempt first |
| **3** ✅ | **Late-arrival buffer** *(SHIPPED 2026-07-20)* | Don't cancel; keep the abandoned promise. If it resolves before the turn is answered, use it | Cheap (~30 lines); directly catches the observed "arrived at 31s after a 30s cut" case; no extra generations | Doesn't help when the primary is genuinely dead; result can arrive after the child gave up | Bound the buffer to the turn's lifetime; discard on client disconnect |
| **4** | **Quality-preferring hedged race** ⭐ | At a hedge point (not a hard deadline) start the next model *in parallel*, keep earlier ones running. When one completes, hold briefly (grace ~5s) for a higher-tier attempt still in flight. Serve the best that lands | Solves P1 **and** P2 properly. Latency ≈ fastest model; quality ≈ best model. Extends the hedge mechanism already proven in `replyStream` | 2–3 concurrent generations per rescued turn (cost). Most complex option. Grace window adds a small tail latency | Hedge only on build turns; cap concurrency at 2; one hedge per turn (already the rule); circuit breaker so a real outage doesn't fan out (PRD-MODEL-FALLBACK §5.2) |
| **5** | **Fix the trigger (patch reliability)** ⭐ | Find why `inSource=false` — the model patches against a version we don't hold — and stop the escalation happening at all | Removes the whole problem class rather than making failure affordable. Cheapest turn is the one that never regenerates | Doesn't help genuine provider outages; needs real diagnosis first (KNOWN_BUGS #5) | The `inSource=` debug line already ships; a persistent false streak confirms the cause before any code changes |
| **6** | **Escalate cheaper before regenerating** | On patch failure try `strictEditRetry` (4096 tokens) *before* a full 24576-token rebuild | Much cheaper/faster middle rung; preserves the child's existing game | One more round trip when it fails too | Cap at one attempt; fall through to regeneration unchanged. Partially exists already (route.ts:372) — needs to run on *this* failure path too |

⭐ = recommended pair.

## 4. Recommendation

**Do 5 first, then 4, keeping 1 as the floor.**

1. **Option 5** — diagnose `inSource=false`. Every incident started there. This
   is diagnosis before code, and it may remove 80%+ of occurrences.
2. **Option 6** — cheap insurance while 5 is investigated: try the small
   strict-edit retry before committing to a whole-game rebuild.
3. **Option 4** — the real architectural fix for genuine outages. Build it on
   `model-runner.ts`, which is now extracted and covered by F.1–F.19, so the
   delicate hedge/restart logic has a regression net.
4. **Option 2** last, and *narrowly*: cancel only attempts that have definitively
   lost. Cancelling eagerly would re-create P2.

**Explicitly not recommended alone:** Option 2 by itself. It fixes the money and
worsens the thing the owner actually cares about.

## 5. Risks of the recommended path

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Concurrent generations multiply spend during a long outage | Medium | Medium | Circuit breaker (PRD-MODEL-FALLBACK §5.2): once the primary is known-bad, go straight to the fallback with no hedge. Cap concurrency at 2 |
| Grace window makes fast turns feel slower | Low | Low | Only wait when a higher-tier attempt is genuinely in flight; cap at ~5s; skip grace entirely if the completed answer is already top-tier |
| Refactoring the hedge breaks restart semantics (2026-07-11/13 incidents) | Medium | **High** | `gemini.fallback.test.ts` F.1–F.19 must pass untouched; any change that needs a test edited is a behaviour change requiring sign-off |
| A hedged OpenAI answer bypasses moderation | Low | **Critical** | `OpenAIGenerator` gates input and output; a raced result must go through the same gate before it can win. Add an explicit test |
| "Best tier" is a guess, not a measurement | Medium | Medium | Tier is currently editorial. Validate with the prompt-portability eval before letting tier decide quality outcomes |

## 6. Scale ceilings

Hedging multiplies upstream calls per turn. At current volume this is
comfortable; the trigger to revisit is either a sustained provider incident
(where the circuit breaker must carry the load instead) or concurrent users
high enough that 2× calls approaches a rate limit. Breaker state is per-process
memory — a second app instance needs shared state first.

## 7. Open question for the owner

How long is a child actually willing to wait for a game? Every option above is
really a trade of *wait* against *quality*, and that number is currently
implicit (30s, then 120s, both picked from system constraints rather than from
what a 7-year-old tolerates). A real answer here would let the grace window and
the whole chain budget be derived rather than guessed.


---

## 8. Shipped: option 3 (2026-07-20)

`runOneShotChain` no longer discards. `slotDeadlineMs` now only ADVANCES the
chain — when it passes we start the next model as a **backup** and keep every
earlier attempt running. The first attempt to succeed wins, whoever it is, and
after the chain is exhausted any still-running attempt keeps its remaining
budget rather than the turn being failed seconds before its answer lands.

The build deadline came DOWN from 120s to **60s** as part of this, which is
counter-intuitive but correct: a shorter deadline now means "start a backup
sooner", not "throw work away sooner". The primary keeps running either way,
and at 60s in it is far closer to done than a backup starting from zero.

`withTimeout` is deliberately no longer used on the one-shot path. Re-adding it
would restore the exact discard-then-degrade behaviour that served children the
weakest model's answer.

Bounded by `totalBudgetMs` (default: one slot per model plus one) so a hung
provider cannot strand a turn — B.7 pins it.

Tests: `model-runner.oneshot.test.ts` B.1–B.7. B.1 reproduces the production
shape directly — a primary that lands after its deadline still beats a freshly
started fallback, and the chain never degrades to the third model.

**Option 5 — DIAGNOSED + fixed for the common case (2026-07-20).** The
`inSource=false` trigger is now understood from code (not a guess):
`injectAssets` strips the `<!--USES_MODELS-->`/`USES_THREE`/`USES_AUDIO` markers
out of the delivered game, but the model re-emits them in its SEARCH block, so
the SEARCH can't be found in the marker-stripped stored source. The two earlier
hypotheses (history-trim, pin race) were wrong. `reconcileAssetMarkers`
(game-edit.ts) strips those markers out of the reply the same way injection did
and re-applies before escalating — guarded so it can only rescue a failed patch,
never regress a new-asset add (`game-edit.reconcile.test.ts`, `markers.test.ts`;
`BUG-FIX-LOG.md` 2026-07-20). Residual (a SEARCH spanning the injected `<head>`)
still needs a prod streak to size — the new `afterMarkerStrip=` log flag will
tell us. Tracked in KNOWN_BUGS #5 (now WATCHING).

**Option 6 — SHIPPED (2026-07-20).** On a failed edit patch the route now tries
ONE cheap `strictEditRetry` (4096 tokens) BEFORE the full 24576-token rebuild
(`api/chat/route.ts` failed-patch branch). A clean, import-safe patch keeps the
child's exact game; anything else (declined, `NEEDS_FULL_REBUILD`, a bad three
import, a throw) falls through to the unchanged regeneration. Capped at the one
attempt. Tests `route.test.ts` DR.1–DR.3.

**Option 4 — DEFERRED pending the H eval (owner decision 2026-07-20).** A closer
read of the streaming runner (all of `gemini.fallback.test.ts` F.1–F.22) found
its premise is weaker than this doc assumed:

- The hedge fires only on TRUE silence — the stall timer resets on every chunk,
  including thought summaries — so it triggers only when the primary emits
  nothing at all for 30s. When a lower-tier hedge then wins, the higher-tier
  primary has been dead-silent 30s+, so "prefer the higher-tier" usually means
  "wait for a probably-dead model." Option 4's core win rarely applies here.
- `chainFor` already orders tier-then-price, so the hedge is usually the SAME
  tier as the primary — much of the quality drop Option 4 targets is already zero.
- §5's own risk row ("'best tier' is a guess, not a measurement — validate with
  the prompt-portability eval before letting tier decide quality outcomes") is a
  hard precondition: Option 4 makes tier decide quality outcomes. The H harness
  exists (`src/lib/eval/`, `npm run eval:portability`) but has NOT been RUN.
- The faithful "best-tier-wins / grace even for a stalled primary" version edits
  F.10/F.11-style "first-answer-wins" behaviour and delays every hedge rescue —
  a sign-off-gated behaviour change.

**Precondition to revisit:** run H with real keys. If it shows tier actually
predicts game quality, build F then WITH that evidence (and a sign-off on any
F-test edit). If it does not, tier is noise and F should be dropped, not built.
Until then the streaming path keeps committing on first token — which, given the
silence-only hedge trigger, is very close to optimal already.


---

## 9. Ruled out by observation (2026-07-20)

**Multi-game chats are NOT a cause of the regeneration failures.** The
hypothesis was that a chat holding several complete games made the model quote
SEARCH text from the wrong one, producing `inSource=false`. The owner, who runs
the live sessions, reports this is not what is happening. Recorded here so it is
not re-proposed: it is a plausible-sounding theory that the evidence does not
support, and `inSource=false` still needs a real diagnosis.

The one-chat-one-game prompt (§10) is still wanted, but on its own merits —
consent before a destructive rebuild, and a clean record — not as a fix for
this bug.

## 10. Guard-rail added with the option-3 work

Keeping attempts alive made chain DEPTH dangerous. The auto chain is up to 5
models; at a 60s slot each that is a **360s worst case — worse than the 225s
incident the change was fixing.** A child waiting six minutes is a failure
however good the eventual answer is.

- `ONESHOT_MAX_MODELS = 2` — primary plus one backup. A slow primary still wins
  (it keeps running); a dead primary is covered by the backup. A third would
  start near 120s and land near 160s, past the point anyone is still waiting.
- `ONESHOT_TOTAL_BUDGET_MS = 150_000` (`GEMINI_ONESHOT_BUDGET_MS`) — a hard
  ceiling, deliberately ≥ one slot plus the slowest observed build (60s +
  46.4s) so a started backup is never killed just before finishing.

Pinned by `gemini.fallback.test.ts` F.20–F.22. Note the streaming path is
unaffected: it RACES rather than queues, so depth there does not add wait.

---

## 11. New-game detection → "start a new chat?" prompt (owner decision 2026-07-20 — BUILT 2026-07-20)

**Status: SHIPPED.** All three build-order steps done, test-first:
1. **Detection + decision** — `detectsNewGame(reply)` (game-edit.ts): the model
   self-declares with a `NEW_GAME_REQUEST` sentinel via the new clause in
   `GAME_EDIT_PROMPT_SECTION`; detection fails toward NOT asking (sentinel must
   stand alone, no patch/no full game in the reply). Tests `game-edit.test.ts`
   NG.1–NG.6.
2. **Stream event** — the route's edit branch returns the friendly
   `NEW_GAME_PROMPT_LINE` with `newGamePrompt: true` on the `done` event and a
   NULL artifact, so the child's current game stays untouched in the preview
   (nothing rebuilt — consent BEFORE destruction). Backward-compatible: old
   clients ignore the field. `route.test.ts` N.1–N.3.
3. **Two-button UI** — `ChatPanel.container.tsx`: "New game 🎮" opens a fresh
   chat and builds there (this one stays exactly as it is); "Change this one ✏️"
   re-sends with `forceRebuild: true`, which the route uses to skip detection and
   rebuild the new game in place. One tap, no typing. Visual pass done.

The `inSource=false` diagnosis (§8, KNOWN_BUGS #5) is separate and also landed;
this prompt reduces how often the destructive rebuild path is reached and makes
it consensual when it is.

---

### Original design notes (kept for rationale)

**The idea (owner):** when a child in a game chat actually asks for a *different*
game ("now make a football game"), don't silently rebuild in place — recognise
it and ask: *"That sounds like a whole new game — want to start a fresh chat for
it?"* Two payoffs: (1) explicit consent before a destructive full rebuild, and
(2) one chat stays one game, so the record is clean and history-trim can't mix
versions.

This does NOT replace fixing `inSource=false` (§9, KNOWN_BUGS #5). It reduces how
often the destructive path is reached and makes it consensual when it is. A
patch can still misfire inside a single-game chat, so the diagnosis is still owed.

**Why regeneration is genuinely needed — the decision table:**

| Case | Patch works? | Handled today |
|---|---|---|
| No game yet ("make a racing game") | Nothing to patch | ✅ `lastGameIndex === -1` |
| A DIFFERENT game ("now a football game") | Patch would be the whole file | ❌ treated as an edit → full-file reply → strictEditRetry → regeneration. Right outcome, wasteful path — **this prompt targets it** |
| Structural change ("make it 3D"/"two-player") | Touches ~every line | ❌ same. (3D + multiplayer already have gates — the system half-knows) |
| Base unusable (blank/dead imports) | Patching a corpse yields a corpse | ⚠️ partial: import-lint corrective retry (`route.ts:461`) |
| Accumulated drift after many patches | speculative — no evidence in logs | ignore until observed |

Regeneration should follow the CHILD'S INTENT, never our machinery failing. Today
the ONLY regeneration trigger that fires in practice is patch *failure*, which is
backwards.

**Detection — chosen approach: model self-declares, corroborated.** The edit
prompt (`GAME_EDIT_PROMPT_SECTION`) already asks for one sentence before the
patch; add "if this is really a different game, not a change to this one, say so
instead." It sees both the request and the current game, costs nothing extra, and
is corroborated by the signal we already compute (model returned a full file, not
a patch). Rejected alternatives: keyword heuristics ("add a football" false-
positives), and a separate classifier call (latency + cost on every edit turn to
catch a rare case).

**Risks + mitigations:**

| Risk | Mitigation |
|---|---|
| False positive interrupts a child mid-flow | Fail toward NOT asking — only prompt on high confidence; ambiguity stays an edit |
| Choice friction | One tap, no typing: "New game 🎮" / "Change this one ✏️" |
| Child fears losing work | Nothing is lost either way — old game stays in the old chat, playable. Say so in the copy |
| Prompt ignored/dismissed | Default to edit — the safe path never destroys |
| In-place rebuild hides regressions | If "change this one", it IS a real regeneration → fire `REBUILT_GAME_LINE` (already exists) |

**Build order (test-first):** (1) detection signal + decision logic — pure,
testable, no UI; (2) the stream event; (3) the two-button UI. Prove the risky
judgment before it reaches a child's screen.
