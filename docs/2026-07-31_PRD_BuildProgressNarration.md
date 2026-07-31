# PRD — Build Progress Narration: show the work, not just the wait

Status: **drafted 2026-07-31**, not yet built. Owner-driven (psychology
rationale, not a bug report) — paired with `docs/PRD-IDEA-BUTTON.md`'s
2026-07-31 note (mic tab turned off, same reasoning): a one-tap shortcut and a
silent black-box build both make the game feel like it assembled itself
rather than something the kid asked for and watched happen.

## 1. Problem

**This is not a "waiting screen" problem — during almost every build after
the first, the kid is already actively PLAYING.** `ArtifactFrame` keeps the
CURRENT game fully playable while an edit streams in behind it (`busy && tab
=== "preview"` strip, PRD-PREVIEW-PANE §2) — there is no dead time to fill,
there is a kid mid-game who asked for something and is still in the world
while it's being made real. Framing this as "what do we show while they
wait" misses that: the goal is to make the CONCURRENT experience — playing
now, watching their ask land — feel like collaboration happening in real
time, not a caption bolted onto a loading spinner.

Today what they get during that live moment is either:
- **First build (no game exists yet, nothing to play):** a chat bubble with
  a single italic "thinking" line (`thinkingLine` from `kidThoughtLine()`, or
  a generic staged `waitLine()` fallback if no thought text arrived).
- **Every edit/rebuild (already playing the current version):** a static
  strip over the preview reading `Making "<the kid's ask>" — you can keep
  playing this one! ✨` — same wording for the entire build, however long it
  takes, regardless of what's actually being made.

Neither reflects that something specific is happening right now, in
sequence, while they're in the middle of playing. It reads as one caption
either way — not a build coming together in front of them.

## 2. Tech Feasibility

Investigated (Explore agent, 2026-07-31) before committing to an approach:

- **The wire protocol has no structured step/plan data.** `/api/chat` streams
  NDJSON events (`thinking` | `delta` | `restart` | `usage` | `done` |
  `blocked` | `error`); `delta` is raw prose/code streamed token-by-token, no
  markers. SEARCH/REPLACE hunk headers and `// --- LANDMARK ---` comments
  exist sometimes but are optional and model-dependent — not reliable enough
  to key narration off.
- **A real, working precedent already exists:** `kidThoughtLine()`
  (`src/lib/kid-thought.ts`) filters Gemini's own live "thinking" summary text
  (`kind:"thought"` chunks, sent before any `delta`) into short, safe,
  code-free prose, shown today as `thinkingLine` in the chat panel. This is
  genuine model-derived narration of what's actually being planned/built as
  it happens — not canned text — and it arrives WHILE the kid is still
  playing the current game, which is exactly the live moment this PRD is
  about.
- **Wall-clock budget is not a blocker.** `wait-line.ts`'s staged fallback and
  the ~45s stall watchdog confirm builds/edits routinely run many seconds to
  tens of seconds — enough time for several distinct thought chunks to arrive
  and be shown in sequence while the kid keeps playing.
- **Two viable approaches, one rejected:**
  1. *(chosen)* Keep reusing the thought-stream channel; add a lightweight,
     pure, keyword→emoji labeling pass on top of the already-filtered prose.
     No model/prompt change, no new wire protocol, reuses a proven
     safe-filtering pattern. Trade-off: wording tracks whatever Gemini's
     thoughts happen to mention, so phrasing/consistency will vary turn to
     turn (owner explicitly accepted this trade-off).
  2. *(rejected)* Explicit structured step list emitted by the model
     up front (like `NEW_GAME_SENTINEL`). More consistent wording, but a
     prompt change, a new parse/strip point, and more testing surface than
     this feature needs.
- **No new surface for the first build.** `ArtifactFrame` only mounts once
  HTML exists — there's nothing to overlay before that, and no old game to be
  "still playing" (the concurrent-play framing above doesn't apply yet).
  First-build narration stays in the chat panel's existing thinking-line
  slot; only the copy quality improves, no new UI.

## 3. Tech Plan

**New pure module — `src/lib/build-narration.ts`:**
```ts
export interface BuildStepLabel { emoji: string; text: string }
export function buildStepLabel(thoughtLine: string): BuildStepLabel
```
- A small ordered keyword→emoji table (dinosaur→🦖, stadium/field/arena→🏟️,
  bat/swing→🏏, sound/audio/music→🔊, score/point→🏆, jump/hop→🦘,
  color/paint→🎨, ball→⚾, cloud/sky/background→☁️, character/player→🧍,
  enemy/monster→👾), first case-insensitive match wins.
- No match → generic `🛠️`, never a missing/blank emoji.
- Pure, framework-free, fully unit-tested (table-driven, mirrors
  `kid-thought.test.ts`'s style).

**Two call sites, same underlying signal, no new state:**
1. **Preview update strip** (`ArtifactFrame.tsx` `updatingLine`, sourced from
   `ChatPanel.container.tsx`, where `thinkingLine` is already lifted to
   container state): while the kid keeps playing the current game, feed
   `buildStepLabel(thinkingLine)` into `updatingLine` whenever a thought line
   is live, replacing the static "Making \"...\"" line so the strip narrates
   *what's actually happening right now* alongside their play. Falls back to
   today's static line for the moment before the first thought chunk of that
   turn arrives, or for turns with no thought text at all (thought streaming
   is builder-mode-only) — never worse than today.
2. **Chat thinking line** (first build, no game to play yet): same
   `buildStepLabel()` treatment on `thinkingLine`, replacing the generic 💭
   prefix with the derived keyword emoji. Keeps today's `waitLine()`
   fallback untouched when there's no thought text.

Both surfaces read off the SAME signal, so on an edit the strip over the game
the kid is playing and the chat bubble narrate in lockstep — one build, one
story, seen from wherever the kid's looking.

**Scale ceiling:** pure string transform, negligible cost; no new
localStorage, no new network calls, no server change.

**Test coverage (test-first, per CLAUDE.md):**
- `src/lib/build-narration.test.ts` — table-driven: each keyword maps to its
  emoji, case-insensitivity, no-match falls back to 🛠️, empty string handled,
  first-match-wins when multiple keywords appear.
- Extend `ChatPanel.container.tsx`'s existing behavioral tests: thinking line
  present → derived label rendered in both slots; thinking line absent →
  `waitLine()`/static fallback unchanged (no regression to the existing,
  already-shipped fallback behavior).

## 4. Use Cases

1. **Kid is mid-game, taps a tweak, keeps playing while it builds** — the
   preview strip over their still-live game updates from generic "Making
   ..." to "🏏 Making the bat swing faster" the moment a matching thought
   chunk arrives — the build feels like it's happening WITH them, not behind
   a curtain.
2. **First build, no game to play yet, model mentions a concrete noun** — the
   chat's thinking line shows "🦖 I'll start with the dinosaur running across
   the screen" in place of a generic 💭 line.
3. **Thought text empty, late, or the turn isn't builder-mode** — both
   surfaces fall back to their existing, already-shipped behavior
   (`waitLine()` in chat, static "Making..." line in preview) — this feature
   can only improve on today, never regress it.
4. **Several distinct things get planned in one turn** (dinosaur, then later
   the stadium) — each new thought chunk re-runs `buildStepLabel()` and
   replaces the line in place (same behavior `thinkingLine`/`updatingLine`
   already have today), reading as a sequence of real moments rather than one
   static caption — without needing new UI for a growing checklist.
5. **A keyword-less, purely procedural thought** ("adjusting the physics
   values") — generic 🛠️ prefix, never a missing emoji, so the strip never
   looks broken mid-sequence.
