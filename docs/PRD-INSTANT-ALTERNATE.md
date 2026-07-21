# PRD — Instant Alternate / "Different one": a second version when the kid needs it

2026-07-20 · Status: **On-demand variant SHIPPED; saved-runner-up variant
DEFERRED** (owner decisions same day).

**2026-07-21 — button hidden (code kept).** The owner found the "🔄 Different
one" copy misleading, so the button's JSX in `ChatPanel.container.tsx` is
commented out (UI removed). The whole path behind it is intact —
`handleDifferentOne` → `regenerate(true)` → `preferAlternateModel` chain reorder,
the `differentVersion` API field, and `gemini.different-one.test.ts` DA.1–DA.3 —
so it can be resurfaced via a clearer entry point later. The `preferAlternateModel`
path is currently only reachable via a direct API call with `differentVersion:true`.

## Status update (2026-07-20)

The owner asked whether the second LLM response is saved and usable. It is NOT —
today the streaming hedge loser is cancelled and the one-shot runner-up is
discarded (§1). Two ways to give the child "a different version when needed" were
put to the owner:

- **On-demand "🔄 Different one" — CHOSEN + BUILT.** A button on the latest game
  reply regenerates the turn led by the FALLBACK model (`replyStream`'s
  `preferAlternateModel` → chain `[...fallbacks, primary]`; route reads
  `differentVersion`; `ChatPanel.container.tsx` button + `regenerate(true)`).
  Safe — NO runner surgery, the hedge/restart logic (F.1–F.22) is untouched — and
  always works; it *rebuilds* a different take rather than reusing a saved one.
  Moderated when it lands on a `provider-enforced` model; prompt-only stays gated.
  Tests: `gemini.different-one.test.ts` DA.1–DA.3, `route.test.ts`.

- **Saved runner-up (reuse the already-generated 2nd answer) — DEFERRED.** The
  *valuable* saved alternate is the streaming game's runner-up, and capturing it
  needs the same delicate hedge surgery as PRD-RESILIENT Option 4 (the loser is
  lower-tier and may never finish — leak/timeout risk). The *safe* saved
  alternate (one-shot runner-up) is rarely the kid's main game. Left as the
  follow-up below; the design/decisions still stand.

The original proposal (below) is kept because the saved-runner-up build, if
revisited, follows it — including **Decision A** (fail closed: only ever show an
alternate from a moderated slot).

---

## Original proposal (design for the deferred saved-runner-up build)

## 1. The observation (correct)

When a turn hedges or keeps attempts alive, we generate MORE than one answer but
serve only one. The owner asked whether we can keep the other and use it when the
shown game is broken, or when the child just wants something different.

Today we **do not** keep it:

| Path | What happens to the 2nd answer |
|---|---|
| **Streaming** (`runStreamChain`) | The hedge LOSER is **cancelled** — `abandon()` calls `it.return()` and closes its stream. It never fully forms. |
| **One-shot** (`runOneShotChain`) | The first success is returned immediately; any other in-flight attempt keeps running but its result is **discarded** (nobody reads the resolved promise). It is generated — and billed (PRD-RESILIENT "P1 abandonment") — then thrown away. |

So the streaming loser is destroyed; the one-shot runner-up is *generated then
dropped*. Neither is available for "show the kid the other version."

## 2. The feature — "instant alternate"

1. **Capture instead of discard.** One-shot: keep the runner-up promise; when it
   resolves, stash it. Streaming: stop cancelling the loser — let it finish into
   a bounded buffer.
2. **Stash it, keyed to the reply.** Reuse `turn_results` (resumable
   generations, TECH_DEBT #23) — add an `alternate` slot next to the shown answer.
3. **Use it in two moments:**
   - **Bug** — self-heal exhausted, or the preview verifier flags the shown game
     dead → swap to the alternate **instantly**, no regeneration.
   - **Kid doesn't like it** — a "🔄 Show me a different one" button serves the
     stashed alternate with zero wait, instead of a fresh 30–60s build.

## 3. Why it's genuinely useful

The cheapest recovery is the one that needs no new generation. Both the bug path
and the dislike path today cost a full rebuild (slow, and — per KNOWN_BUGS #5 —
sometimes a *destructive* one). An already-generated, already-paid alternate
turns both into an instant swap.

## 4. The two decisions that gate a build

**Decision A — safety of the alternate (REQUIRED, safety boundary).** The
alternate must pass the SAME gate before a child sees it.
- Gemini native + OpenAI (moderated) alternates are already safe to show.
- The new **prompt-only** Claude/Kimi have NO output moderation — their
  runner-up cannot be shown to a child without adding one.
- **Recommendation (fail closed):** only ever capture/show an alternate from a
  `provider-enforced` slot. A prompt-only runner-up is never stashed. No new
  moderation work, no lowered floor. Revisit only if a moderation adapter is
  added for those providers.

**Decision B — auto-swap vs. offer (UX).**
- **Bug path:** auto-swap is safe and good — the shown game is already broken, so
  replacing it with a working alternate is strictly better. Fire `REBUILT_GAME_LINE`
  so the change is honest.
- **Dislike path:** offer a button, never auto-swap — the child asked for
  *different*, and the alternate is often the *weaker* fallback model (see below).
- **Recommendation:** auto-swap on a verified bug; button on dislike.

## 5. Honest limitations (write them into the UI copy / telemetry)

- **"Different" ≠ "better."** The alternate is usually the weaker fallback model
  (the primary won the race precisely because it was better/faster). Good for
  "give me another," poor for "give me a better one." The real "better" is
  Option 4 (quality-preferring race, PRD-RESILIENT §3) — a separate lever.
- **Cost/memory.** Keeping a second full game (~15 KB) per turn, and on the
  streaming path *not* cancelling the loser, brings back some of the billing
  Option 2 was meant to stop. This is a deliberate trade: pay for the second
  generation on purpose because it buys instant recovery. Cap: one alternate per
  turn; drop it on turn expiry / client disconnect.
- **Staleness after an edit.** Once the child edits the shown game, the alternate
  (built from the pre-edit request) is stale → discard it on the next turn.

## 6. Scale ceilings

One alternate per turn, held for the turn's lifetime, provider-enforced only.
Memory is bounded by concurrent in-flight turns × ~15 KB. Trigger to revisit:
if alternates are kept longer than a turn (e.g. persisted across reloads), the
`turn_results` retention + size budget (MEMORY_BUDGET) must be re-sized first.

## 7. Build order (test-first, when approved)

1. **Capture** — one-shot: return `{ primary, alternate? }` from the runner
   without changing which one wins; streaming: buffer the loser instead of
   `abandon()`, provider-enforced only. Pure runner change, unit-tested; the
   existing F.1–F.19 / B.1–B.7 behaviours must stay green (the WINNER is
   unchanged — this only stops *discarding* the loser).
2. **Stash** — extend `turn_results` with an `alternate` column + read path.
3. **Use** — bug path auto-swap in the repair flow; dislike-path button in
   `ChatPanel.container.tsx`, provider-enforced-only, honest copy.

Prove capture (does not change the winner; drops prompt-only) before it reaches
a child's screen.
