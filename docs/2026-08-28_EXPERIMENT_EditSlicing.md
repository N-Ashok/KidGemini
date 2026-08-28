# Experiment — send an edit turn only the sections it needs (2026-08-28)

**Owner ask (2026-08-27→28):** "any other way to make it cheaper without
compromising quality?" → then: "ask the first build pass to give a short
summary line for each section and use it for the edit turn."

## The idea

An edit prompt is ~22k tokens and ~18k of it is the child's whole game. Most
asks touch two or three parts. The build already writes landmark comments; now
it also writes **what each part does**, so an edit can be shown a table of
contents plus only the bodies it needs.

Build contract (`GAME_BUILD_CONTRACT`) now asks for
`// --- PLAYER MOVEMENT: arrow keys and the on-screen buttons steer the car ---`
and `<!-- SCORING: shows the score box and adds 10 points per coin -->`.
`EDIT_CRAFT_RULES` keeps summaries, writes one for any new section, and tells
the model that collapsed sections still exist and must not be edited or
re-created.

`src/lib/edit-slice.ts` splits the model view on its landmarks, shows the
sections the ask names plus any state/variables/config section, and collapses
the rest to their landmark line + a `hidden: N unchanged lines` note. Shown
text is **verbatim**, so SEARCH/REPLACE hunks still apply to the full
document; a miss is a normal `search_not_found` and the existing strict retry
re-sends the FULL source. Behind `EDIT_SLICE=on`, default OFF.

## Measured

**Build side** — one real generation with the new prompt: **12 of 12 landmarks
carried a summary**. The model needed no coaxing.

**Edit side** — six real edits on that game, same asks, both arms, on the real
`/api/chat` path:

| | applied | avg input | avg output | $/edit |
|---|---|---|---|---|
| slicing OFF (control) | 6/6 | 4,974 | 682 | $0.0063 |
| slicing ON | 6/6 | 2,743 | 518 | **$0.0040** |

**On this 2D game: −45% input, −36% cost, no quality loss found** (see the 3D section above — the 3D run did find one):
- 12/12 resulting games **run clean in a browser** (`verify-game-html.mjs`).
- **Every hidden section survived every sliced edit** (12/12 landmarks intact,
  documents complete, no placeholder text leaked into a saved game).
- Diffs are correct and *more surgical* when sliced (colour change: 2 changed
  fragments vs 6; add-a-boss: 15 vs 54).
- "Add a boss on level 3" added a **13th landmark in the summary format** — the
  edit-side rule works.

## 3D result — slicing BROKE a game (2026-08-28, do not ship as-is)

Repeated on a real 3D game (city driving, 48,318 chars delivered / **14,765
chars model view** — the injected Three.js runtime is already stripped, so a
3D game is not as large to the model as it looks). Build side again clean:
**10/10 landmarks summarised**. Six edits per arm:

| | applied | avg input | avg output | $/edit |
|---|---|---|---|---|
| slicing OFF | 6/6 | 8,073 | 484 | $0.0051 |
| slicing ON | 6/6 | 6,266 | 524 | $0.0057 |

- **Input −22%**, but the game source is only ~46% of a 3D edit prompt (the 3D
  playbooks and model names take the rest), so the ceiling is lower than 2D.
- **Total cost difference is INSIDE THE NOISE at n=6** — 3 turns cheaper, 3
  dearer; output tokens swung 122→1,212 between otherwise identical asks, and
  output costs 5x input. The point estimate is +12% (worse); it is not
  significant either way. Resolving it needs ~20–30 turns per arm.

**The blocking finding.** `"change the sky to night"` under slicing produced a
game that **does not run**: `Identifier 'init' has already been declared`. The
picker showed 2 of 10 sections; the sky/lighting setup lives in
INITIALIZATION, which it hid (the ask's words are not in that section's
label). Unable to see `init()`, the model **rewrote it from scratch** and
appended a second copy. The control arm's same ask has one `init` and runs.

This defeats the safety story. The design assumed a picker miss shows up as
`search_not_found` → full-source retry. It does not: the model emitted a
valid ADD hunk, which applied cleanly and broke the game. **A miss can ship
broken code, not just waste an attempt.** Keeping the collapsed
landmark+summary index was not sufficient protection.

**Resolution (owner decision, same day): slicing is 2D-ONLY.** Enforced inside
`sliceEditSource` itself (not at the call site, so nothing can opt a 3D game
back in) using `game-edit.ts`'s `gameUsesThree` — the same predicate billing
and the 2D→3D conversion use, so the three can never disagree. Verified on the
real path: with `EDIT_SLICE=on`, the 3D game that broke now logs zero slicing
engagements, bills the same input as the unsliced control (6,270 tok), has one
`init()`, and runs clean in the browser.

Still required before 3D could ever be included:
1. **A post-apply duplicate-declaration guard** — cheap, deterministic: if an
   edit introduces a second top-level `function`/`const`/`let`/`class` of a
   name that already existed, discard the patch and do a full-source turn.
   This catches exactly this class regardless of picker quality.
2. **A better picker** — the lite-model section picker (the TOC is ~175
   tokens) would have shown INITIALIZATION for "change the sky".
3. Re-measure both, 20–30 turns per arm, on 2D and 3D.

## What did NOT work (measured, then fixed)

- **Body keyword matching over-selects.** "Make the buttons bigger" matched
  `width`/`height` in eight of twelve sections, until the saving guard gave up
  and sent the whole file. Selection now trusts the build's LABELS; the body is
  only a tiebreak between sections the labels already matched.
- **"Always show the first section" was wrong.** It assumed section 0 is game
  state (true of the toy fixture); in a real generated game section 0 is
  STYLING. Replaced with a near-exact match on state/variables/config/data
  titles.
- **Matching the summary text for "state-ness" was too loose** — ordinary
  English ("**setting** up the sky", "**level**ing up") hit 7 of 12 sections.
  Title only.

## Known gaps

- **Games built before today have bare landmarks.** They keep the older
  body-matching path, which is noisier; the full benefit only reaches games
  built from now on.
- **The picker can still miss.** "Make the score go up by 20" shows the section
  whose summary mentions the score *display*, while the code that increments it
  lives in GAME ENGINE. That is a `search_not_found` → full-source retry: a
  wasted attempt (~40% of one edit), never a wrong game.
- **Measured on one small 2D game (12.4k chars).** Production games average
  ~35k model-view chars, where the saving should be larger and the fixed slice
  note proportionally cheaper — unverified.
- **Next step if the picker proves too crude:** the summaries make the table of
  contents ~150 tokens, so a lite-model section picker becomes cheap and would
  replace the keyword scoring entirely.

## Files

`src/lib/edit-slice.ts` (+ `edit-slice.test.ts`, 14 tests) ·
`src/lib/gemini.ts` (`GAME_BUILD_CONTRACT`, `EDIT_CRAFT_RULES`, the
`buildContents` hook) · `scripts/edit-slice-experiment.mjs` · `.env.example`
(`EDIT_SLICE`).
