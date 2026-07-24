# PRD — Unified Idea Queue v2 (one line for every idea, everywhere)

**Status:** SHIPPED 2026-07-24 (same day as design; owner approved autonomous build) ·
**Owner decisions:** 2026-07-24 · **Build notes:** the drain race on restore is
killed by *initializing* the hold to `"restored"` (not just setting it in an
effect — a sibling-effect set leaves a one-commit stale-closure window, see
BUG-FIX-LOG 2026-07-24 "silently un-froze"); `fromIdeaBag` keeps its name
(persisted in local + server history) with the bubble label updated to
"✨ Your spoken ideas"; `warn.50` added to the token scale for the full-line
notice; visual e2e in `scripts/e2e-idea-queue.mjs`.
**Supersedes:** `PRD-IDEA-QUEUE.md` (v1 queue) and the 🎒 Idea Bag / ✨ Make-better
half of `PRD-IDEA-BUTTON.md` (the 🎤 mic tab itself stays — only where its ideas
land changes).

---

## 1. The problem v2 solves

v1 shipped two parallel "idea while Ari is busy" systems with different rules:

| | Idea Queue (typed, chat) | Idea Bag (spoken, preview) |
|---|---|---|
| Where visible | card above the composer | 🎒 chip + panel over the preview |
| What one idea becomes | its own build turn | part of ONE ✨ bundle turn |
| When it sends | auto, one per clean finish | when the kid taps ✨ |
| Persistence | on the Conversation (synced) | separate localStorage key (device-only) |

A kid faces two different answers to "what happens to my idea?" depending on
which surface they were on. Worse, on mobile and full-screen preview the panel
(`fixed inset-0 z-[110]`) covers the queue card, the composer, and the
"⏸ Still want these?" prompt entirely — the queue's error state can stall
*invisibly*, and games swap under a playing kid with no warning.

Owner direction (2026-07-24): **one mechanism.** The bag's ideas "come here" —
into the queue.

## 2. Owner decisions (2026-07-24)

| Question | Decision |
|---|---|
| How spoken ideas merge | **One line, smart bundling** — every idea joins the same visible line; rows captured over the preview are `tweak` rows (✨) and consecutive tweaks compose into ONE build turn when they drain; typed rows stay one-turn-each. |
| When tweaks send | **Fully automatic** — tweaks drain like everything else (bundle at next clean finish, or when idle). The ✨ Make-better button **retires**. |
| Queue on mobile / full-screen preview | **Chip + sheet in the preview header** — "⏳ n" chip expands a bottom sheet with the full line (edit/drop/resume); the paused prompt surfaces there too. |

## 3. The unified model

### 3.1 One row type, two kinds

```ts
// idea-queue.types.ts
export type QueuedIdeaKind = "build" | "tweak";
export interface QueuedIdea {
  id: string;
  text: string;
  kind: QueuedIdeaKind;   // NEW — v1 rows sanitize to "build"
  createdAt: number;
}
```

Kind is assigned by **origin**, never inferred from content:

- **`build`** — typed into the composer. "The next thing to make." One row = one turn.
- **`tweak`** — captured via the 🎤 mic tab over the preview. "Change the game
  I'm looking at." Consecutive tweaks send together as one turn.

The card renders `build` rows with their queue number and `tweak` rows with ✨;
adjacent tweaks get a bracket/tint so "these travel together" is visible.

### 3.2 Drain = take one *send unit*, not one row

New pure function replaces `takeNextIdea`:

```ts
takeNextSend(queue): { message: string; taken: QueuedIdea[]; rest: QueuedIdea[] }
```

- Front row is `build` → take that one row; message = its text.
- Front row is `tweak` → take the **maximal consecutive run** of tweaks from the
  front; message = `composeIdeaBundle(texts)` (moves here from `idea-bag.ts`,
  keeps the `IDEA_BUNDLE_LABEL` + "🎒 From your Idea Bag" → re-labelled
  "✨ Your tweaks" chat-bubble marker via the existing `fromIdeaBag` flag,
  renamed `fromTweaks` with a read-compat shim).

Rules 2–4 of v1 carry over verbatim: only a clean finish (`turnOk`) drains,
`sendingRef` serializes, rows leave the line *before* the send.

### 3.3 The idle "settle" beat (why automatic still bundles)

Fully-automatic has one wrinkle: when Ari is **idle**, a naive drain fires the
instant the first tweak lands — a kid speaking three thoughts in a row would get
the first one built alone. So the drain decision gains one input:

- `build` front row + idle → send **immediately** (unchanged v1 feel).
- `tweak` front row + idle → send after **`TWEAK_SETTLE_MS = 4000`** of no new
  enqueues. The card shows "✨ Sending in a moment — keep talking!" during the
  settle so the wait is legible, with a small **Send now ▶** escape hatch.
- Anything + busy → wait (bundle naturally grows until the turn lands).

The settle is a UI timer around a pure decision (`drainDecision` in
`idea-queue.ts`, unit-tested with injected `now`) — no `setInterval` state
capture (Bug class: closure stale state; use a ref per §9).

### 3.4 Cap: 5 rows, tweaks merge instead of being refused

Cap stays **5 rows** (v1 rationale: glanceable + bounds unattended paid turns —
and bundling means 5 rows is *at most* 5 turns, usually fewer).

- Typed `build` at cap → refused with the v1 copy, text kept. Unchanged.
- Spoken `tweak` at cap → **merges into the trailing tweak row** (appends
  "; <text>") rather than refusing — a kid mid-game speaking to the mic tab has
  no composer holding their text, so refusal there *would* silently lose the
  idea (violates v1 Rule 1). If the trailing row is a `build`, the mic bar shows
  "The line is full — Ari will catch up soon! 🙂" and keeps the transcript on
  screen for retry.

### 3.5 Pause gets a reason (fixes the silent-resume trap)

v1 bug: `handleSend` cleared `queuePaused` unconditionally, so typing any fresh
message silently resurrected a line frozen by a stop/failure. v2 models *why*:

```ts
type QueueHold = "restored" | "failed" | null;
```

- Chat opened/switched/reloaded with a line → `"restored"`. A fresh send or a
  new enqueue clears it (nothing is broken; the kid is clearly active).
- Stop or failed turn → `"failed"`. **Only** the explicit "Yes — keep going ▶"
  clears it. Fresh sends, new enqueues, and clean finishes of *other* turns do
  not — the "⏸ Still want these?" card stays until answered.

`queueSendAction` keeps its shape (`hold` whenever `QueueHold != null`).

### 3.6 Edits can't lose to the drain race

v1 rows were uncontrolled + commit-on-blur, so an edit in progress at the moment
of a drain sent the *pre-edit* text and then committed into a dead id. v2 rows
keep a local draft and **commit on every non-empty change** (the empty-draft
case stays local, which is what the uncontrolled hack was protecting against) —
the drain always reads current text. Regression test pins this.

## 4. Surfaces

### 4.1 Chat window (mostly v1, plus kinds)

Card above the composer, "⏳ Next up (n)". Build rows numbered, tweak runs
bracketed with ✨ and the caption "these go together". Composer behavior
(placeholder swap, ⏳ send button, refusal copy, attachment refusal) unchanged.

### 4.2 Preview pane (new — closes the invisibility gap)

- **Header chip**, in the slot the `makeBetterQueued` pill used:
  - building with a line → `⏳ n`
  - held (`"failed"`) → `⏸ n` in warn tint — the stall is never invisible
  - empty line → no chip
- **Tap → bottom sheet** (mobile & expanded desktop; on split-view desktop the
  chip just isn't needed — the card is already beside the panel). The sheet
  renders the *same* `IdeaQueue` component (`variant="sheet"`): full edit/✕/
  resume/drop-all controls, including the "⏸ Still want these?" choice.
- **Game-swap cue:** when a drain replaces the artifact while the panel is
  open, the existing `UPDATING_LINE` banner slot announces "Next up: ‘<idea>’ ✨"
  so the swap is narrated, not silent.
- The 🎤 mic tab is unchanged as a *capture* device; its ✅ now enqueues a
  `tweak` instead of bagging. The 🎒 chip, bag panel, and ✨ button are removed.
  Coach copy (`COACH_LINE`) updates to say ideas "line up for Ari".

## 5. What retires / migrates

| v1 piece | v2 fate |
|---|---|
| `idea-bag.ts` store CRUD, caps, `ideaQueueAction`, ✨ queue flag | retired; `composeIdeaBundle` moves to `idea-queue.ts` |
| `IdeaBag.tsx` chip + panel | removed; queue sheet replaces it |
| ✨ Make-better button + `makeBetterQueued` pill | removed (owner decision); pill slot reused by the queue chip |
| `kidgemini:ideas:v1` bagged ideas | **one-time migration on load:** each convo's bagged ideas become `tweak` rows in that convo's queue while slots remain; overflow merges into the final tweak row (never dropped). Store key cleared after. Arrives `"restored"`-held, so nothing auto-sends. |
| `IdeaRecord`/`sent` analytics (PRD-IDEA-BUTTON §3 phase 2) | note carried to TECH_DEBT — per-row `kind` on the queue preserves the bag-vs-typed signal |
| Mic tab, coach, resize handle | unchanged |

## 6. Rules that must not regress (v2 set)

1. **An idea is never silently lost** — refusals say why and keep the text; the
   mic path merges at cap instead of refusing into the void; migration never
   drops overflow.
2. **Only a clean finish drains**; stops/failures hold with a visible question
   on *whichever surface the kid is on*.
3. **Nothing generates unattended** — restored lines hold; a `"failed"` hold is
   cleared only by the explicit yes.
4. **One send at a time** (`sendingRef`; rows leave before send).
5. **Persisted queues are sanitized** (`kind` defaults to `"build"`, unknown
   kinds dropped) — a queued row auto-sends, so storage is never trusted.
6. **A tweak run is one paid turn** — the drain must never fire tweaks
   one-per-turn (cost regression = the reason bundling exists).

## 7. Implementation plan

| Step | Files | Tests first |
|---|---|---|
| 1. Types + pure logic: `kind`, `takeNextSend`, `drainDecision` (settle), cap-merge, `QueueHold`, sanitize v2, bundle compose moves in | `idea-queue.types.ts`, `idea-queue.ts` | `idea-queue.test.ts` — decision tables for drain/settle/hold, bundling runs, cap-merge, sanitize back-compat |
| 2. Migration: bag → queue rows, key retirement | `chat-store.ts` (load hook), new `idea-migrate.ts` | migration table incl. overflow-merge + idempotence |
| 3. Container rewiring: drain uses `takeNextSend` + settle timer via ref; `QueueHold` replaces `queuePaused`; remove bag/✨ state | `ChatPanel.container.tsx` | existing integration specs updated |
| 4. UI: `IdeaQueue` gains kinds, brackets, `variant="sheet"`, Send-now; header chip + sheet in `ArtifactFrame`; mic ✅ → enqueue; remove `IdeaBag.tsx`; swap-cue line | components | Playwright: chip states, sheet resume, mid-play swap cue, 390px pass |
| 5. Docs same change: this PRD → shipped; FEATURES, REGRESSION-TEST-CATALOG, TECH_DEBT (phase-2 note), BUG-FIX-LOG entries for the two v1 fixes (§3.5, §3.6) | docs | — |

Scale/cost note (§10 CLAUDE.md): unchanged ceilings — cap 5 rows bounds
unattended turns *harder* than v1 (bundling collapses tweak rows into fewer
turns); localStorage shrinks (one store instead of two). No new queries.

## 8. UAT script (delta from v1)

U1. While Ari builds: type an idea, then speak two tweaks over the preview →
    card shows `1 build` + bracketed `✨×2`; finish → build sends alone, then
    the two tweaks send as ONE message.
U2. Idle, speak three tweaks quickly → "sending in a moment" settle, then ONE
    bundle; "Send now ▶" skips the wait.
U3. Fill the line (5), speak another tweak → it merges into the last ✨ row;
    type another idea → refused with copy, text kept.
U4. Stop a queued build mid-stream → ⏸ chip in the preview header; tap → sheet
    shows "Still want these?"; send a fresh chat message → line STAYS held;
    "Yes — keep going ▶" resumes.
U5. Full-screen a game with 2 queued → each swap shows "Next up: …" banner.
U6. Seed old `kidgemini:ideas:v1` with 7 bagged ideas → reload → queue shows 5
    rows (last row merged), held as restored, bag key gone; reload again → no
    duplicates.
U7. Edit row #1's text at the exact moment a build finishes → the EDITED text
    sends.
