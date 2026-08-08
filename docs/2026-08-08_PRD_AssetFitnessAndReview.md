# PRD — Asset Fitness & Human Review

**Status:** Drafted 2026-08-08, from the "poorly formed race track" incident.
**Owner decisions captured in dialogue, 2026-08-08** — recorded in §2.
**Related:** `PRD-3D-GAMES-AND-ASSETS.md` (the library), `docs/BUG-FIX-LOG.md`
2026-08-08 entries (the three faults that motivated this), platform
`docs/TECH_DEBT.md` #93/#94.

---

## 1. Problem

Three separate asset faults reached children this week. Each was invisible to
every check we run, and each was individually undiagnosable by the kid or by
re-prompting:

| Fault | Why no check caught it |
|---|---|
| City road tiles laid 90° wrong | Orientation was never published; the prompt asserted a universal ("every model faces +Z") that was false for half the library |
| `race_track_*` origins 1.15–1.65 m off-centre | The recentring bake existed but had never been published; nothing compared shipped bytes to intent |
| `race_track_curve` is 1.5 × 2 m against a 1 × 1 straight | **Nothing has ever checked that a tile can tile** |

The pipeline today validates: file magic bytes, byte budget, licence proof,
post-upload sha256 + headers, vehicle long-axis (`assertLongAxisZ`), and
origin centring. All real. None of them ask the only question that matters:

> **Does this piece work in the thing a child actually builds?**

The deeper pattern: **numbers we thought to check, we check. Nobody ever looks
at the asset.** The 1.5 m curve would have been obvious in two seconds on
screen and was invisible for weeks in the manifest.

### 1.1 Why re-prompting cannot rescue it

1.5 is not a multiple of 1. No prompt, rotation, or scale factor a child or the
model can write makes those pieces meet. A child told to "fix the curves" enters
an unwinnable loop — which is exactly what the owner experienced before this PRD
was written. **An asset fault is not recoverable downstream.** That is what makes
asset acceptance a correctness boundary, not a nicety.

---

## 2. Owner decisions (dialogue, 2026-08-08)

1. **Human in the loop is the design.** Not "automated gate only".
2. **Never silently mutate geometry.** A machine that rescales a model and ships
   it unseen is precisely "not knowing for sure it is right". Refuse and report;
   a human fixes and confirms.
3. **Earlier assets are IN SCOPE.** A wrong asset is wrong for every game already
   using it. We fix it at source rather than quarantining it behind a gate.
   Explicitly rejected: grandfathering known-bad assets to keep the gate green —
   that optimises for the tool, not the child.
4. **Earlier GAMES are NOT migrated.** No restamp campaign. They self-heal:
   `ensureAssetRuntime` re-resolves the asset table against the current manifest
   on *every preview render*, so a stored game picks up fixed assets the moment a
   child opens it, and a prompt-edit additionally picks up the current teaching.
5. **UI with pass/fail table → preview pane.** Understand what a child would
   prompt and what it actually produces.

---

## 3. Tech Feasibility

Everything this needs already exists in the codebase. Nothing is speculative.

| Need | What we already have |
|---|---|
| Measure geometry off published bytes | `@gltf-transform/core` + `getBounds`, already used by `vendor-models.mjs` and both backfill scripts |
| Declare-then-lint discipline | `scripts/lib/orientation.mjs` (`assertLongAxisZ`) + its unit tests — the exact precedent to copy |
| Render an asset exactly as a game does | `ensureAssetRuntime` + `loadModelHelper` are pure modules; the asset host serves every glb with `CORS *` |
| Admin-gated operator surface | `src/app/admin/page.tsx` — `ADMIN_SECRET` in a POST body so the secret never lands in logs or history |
| Headless browser | Six `scripts/e2e-*.mjs` already drive Playwright |
| Kid-facing asset listing to model the table on | `src/lib/assets/gallery.ts` — pure data, rendered from the manifest, zero backend |
| Regenerate metadata without re-uploading | `backfill-model-sizes.mjs` / `backfill-path-axis.mjs` precedent |

**Key simplification: no stored screenshots.** The review page loads each glb
live from the asset host and renders it with the same loader a game uses. There
is no image to generate, store, diff, or keep in sync, nothing lands on the 1 GB
box, and what the reviewer sees is what a child gets *now* — not a photo of last
Tuesday. This is strictly better than the contact-sheet approach first proposed.

### 3.1 Rendering mechanism — settled, with precedent

`src/app/assets/page.tsx` (the kid-facing gallery) already does exactly this and
is the pattern to copy:

- It reads the engine URL from the manifest (`type === "engine"`) and does a
  **dynamic `import(engineUrl)`** of the vendored three bundle served from
  `assets.ariantra.com`, then `new T.GLTFLoader()` +
  `setMeshoptDecoder(T.MeshoptDecoder)` + `loadAsync(url)`.
- This IS the kid's loader path: `loadModelHelper()`
  (`src/lib/assets/runtime-helpers.ts`) does the same three calls, with `"three"`
  resolving through the injected import map to that identical bundle URL.
- `three` is a **devDependency only** — never imported into app code (that would
  bundle ~600 KB and stop dogfooding the immutable host). No CSP is configured
  in `next.config.js`, so the cross-origin dynamic import works from the page.

**Not an iframe.** `ArtifactFrame`'s `sandbox="allow-scripts"` (no
`allow-same-origin`) is right for running a kid's untrusted game, but here it
would actively get in the way: the parent could not read back triangle counts or
verdicts from inside it. We control this URL, so render in the parent tree.

**Many previews on one page:** the gallery already solves the WebGL-context cap
(browsers limit live contexts) by keeping **one shared renderer and blitting into
per-card 2D canvases**. Reuse that rather than capping the table to one preview
at a time.

**Not feasible / explicitly out:** measuring skinned models' true bounds (platform
TECH_DEBT #93 — needs a CPU rest-pose skinning pass; unrelated to this PRD).

---

## 4. Tech Plan

### Layer 1 — Asset fitness (deterministic, no LLM)

New pure module `src/lib/assets/fitness.ts` + `scripts/lib/fitness.mjs` sharing
one rule set (TS for tests/UI, mjs for the pipeline — same split as
`orientation.mjs`).

Checks, per model, computed from the **published** bytes:

- `pathRole` (new declaration): `'tile' | 'scenery' | 'actor'`. Only `'tile'`
  is held to the module contract. Declaring it is the curator's statement of
  intent; the lint checks they were right.
- **Module**: a tile's X and Z are whole metres and equal (square), or an exact
  integer multiple of the kit's base module.
- **Kit consistency**: every tile in a kit resolves to one base module.
- **Origin**: centred in XZ within tolerance.
- **Axis**: `pathAxis` is declared, and is consistent with the geometry where the
  geometry gives an unambiguous signal.

Output is a **verdict per asset**, not a boolean: `pass | fail | needs-eyes`,
each with the measured numbers and a human-readable reason.

Wiring:
- `vendor-models.mjs` stage 2.5 — **blocking for anything being published**.
  Refuses with the reason and the suggested declaration. Never rewrites geometry.
- A standing sweep over the **whole library**, including already-shipped assets,
  surfaced as a worklist (decision §2.3). Not a build blocker for history —
  a to-do list with evidence.

### Layer 2 — Golden prompts (LLM, deliberate)

A small fixed set of child-shaped prompts stored in-repo, e.g.
`"make me a race track"`, `"make a city with roads"`, `"3d dino game"`.

- Run **on demand**, never per-asset. A 30-asset batch must not cost 30 model
  calls; that cost is what would make the tool get abandoned.
- Each run stores prompt, timestamp, generated HTML, and the verdict a human gave.
- Value is regression: after a prompt edit or a new kit, re-run and compare to the
  last accepted result.

### UI — one admin-gated route in Ari, two tabs

`/admin/assets` (Ari, `ADMIN_SECRET`, same POST-body pattern as `/admin`).

**Tab 1 — Assets.** Row per model: name, kit, role, size, square?, on-module?,
origin, axis, verdict. Filter to failures. Click a row → live 3D pane rendering
the asset **alone** and **snapped to its neighbours with a car for scale** — the
two views that make a tiling fault obvious.

**Tab 2 — Prompts.** Row per golden prompt: text, last run, verdict, run button.
Click → the generated game in the existing preview frame.

### Fix flow (how an earlier asset gets repaired)

1. Sweep flags it, with numbers.
2. Human opens the live preview and confirms it is genuinely wrong.
3. Curator adds an explicit declaration (`normalizeFootprint`, `rotateYDeg`, …).
4. Re-vendor with `--upload`. Append-only host: **published games keep their old
   URLs and cannot break**; stored games self-heal on next render (§2.4).
5. Human confirms in the preview that the fix is right *before* the manifest
   commit ships.

---

## 5. Use Cases (all of them, with how we tackle each)

**UC1 — Curator vendors a new kit.** Pipeline measures every piece, refuses the
batch naming the offending piece and the declaration that would fix it. Curator
declares, re-runs, reviews the live render, ships.
→ Layer 1 blocking gate + Assets tab.

**UC2 — A shipped asset is wrong (today's curve).** Sweep lists it with evidence.
Human confirms on screen. Fixed at source and re-published; stored games repair
themselves on next open.
→ Standing sweep + fix flow (§4).

**UC3 — Owner asks "why is the track still broken?"** Opens the Assets tab,
filters to failures, sees `race_track_curve 1.5 × 2 — not on its kit's 1 m
module` with a picture of it not meeting its neighbour. Answer in seconds, not an
evening of measurement.
→ Assets tab.

**UC4 — A prompt change silently breaks generation.** Re-run the golden prompts,
compare to last accepted. Catches the class where every asset is individually
fine but the system output is wrong — i.e. the 90°-rotation bug, which no
per-asset check could ever have caught.
→ Layer 2.

**UC5 — Deciding between two candidate fixes.** (Live example: rescale
`race_track_curve` to 2 × 2, or retire the racing kit's curve for the city kit
that already tiles.) Render both, choose with a picture rather than a guess.
→ Assets tab, ad-hoc compare.

**UC6 — A child reports a broken game.** Check whether the assets it uses pass;
if they do, the fault is generation, not the library — which is the split that
took an evening to establish by hand this week.
→ Assets tab + Layer 2.

**UC7 — Routine batch, nothing wrong.** All green, one glance, ship. The gate
must be cheap when everything is fine or it will be bypassed.
→ Layer 1 is milliseconds and needs no model call.

---

## 6. Scale ceilings (CLAUDE.md rule 8)

- **Assets tab** renders live glbs in the browser. Beyond ~50 simultaneous
  previews a page would strain a laptop GPU — so render **on row click**, never a
  grid of live canvases. Revisit if the library passes ~500 models.
- **Layer 2** stores one generated HTML per run (~10–40 KB). At a handful of
  prompts × a few runs each this is trivial; cap retained runs per prompt (keep
  the last N) before it becomes a directory nobody prunes.
- **Nothing new runs on the EC2 box.** Measurement happens on the Mac at vendor
  time; the review page is admin-only and renders client-side. No added process,
  no added memory (`docs/MEMORY_BUDGET.md`).
- **Layer 2 costs real Sparks/tokens per run.** That is the reason it is
  on-demand and not wired into the asset gate.

---

## 7. Open decision (resolve with a render, not an argument)

`race_track_curve` is 1.5 × 2 against a 1 m straight. Two candidate fixes:

- **Rescale to 2 × 2.** Matches the kit. Risk: it is an *arc* — a non-uniform
  squash may leave its ends no longer meeting the road edges. Would look correct
  in the table and wrong on screen.
- **Retire the racing kit's curve**, use the city kit (already 1/2/3 m, square,
  with correct `pathAxis`). Nothing to distort, but a "race track" then reads as
  streets rather than a circuit.

Not decidable from numbers. **First job for the Assets tab is to render both.**

---

## 7b. RESOLVED (2026-08-09) — §7 settled by measurement, not by a render

The open decision above assumed the choice was "rescale `race_track_curve` to
2 x 2" vs "retire the racing curve for the city kit". **Both were wrong
questions.** `scripts/render-assets.mjs` measured the published bytes and found:

- The racing kit was **already a complete tiling set**: `race_track_straight`,
  `race_track_corner` and `finish_line` all carry a **0.70 m** carriageway, all
  centred, all on the 1 m module. Nothing needed rescaling or retiring.
- `race_track_curve` is **not a curve**. It enters its north edge at 0.498 m and
  leaves its south edge at 1.002 m — a lateral shift, i.e. a **chicane** — and
  1.002 m is a cell BOUNDARY on the 1 m grid, so no on-grid piece can follow it.
  Rescaling could never have fixed it; the defect is the offset, not the size.
- The city kit is separately consistent at **0.81 m**, and its `road_curve` is a
  valid 2x2 *sweeping* turn (joins at 0.50 m and 1.50 m — both cell centres).
  The 2026-08-08 game's fault was scaling it by `gridSize/2`, halving its
  carriageway against the straights it met.

The real defect was that **none of this was published**, so the model guessed.
Fix: measure it and ship it as data (`joins`, `joinOffsets`, `lane`, `kit`,
`pathRole` -> `window.AR_EDGES` / `modelJoins()` / `rotateToJoin()`).

Two amendments to the plan above, both learned by building it:

1. **`pathRole` is required after all.** §4 proposed `'tile' | 'scenery' |
   'actor'`; the first attempt dropped it to avoid a field nobody maintains.
   That immediately condemned `finish_line`, which is 1.26 m wide against a 1 m
   module and is CORRECT — the overhang is verge hanging over grass. Shipped as
   `'tile' | 'prop'`: a prop straddles the road without tiling it, so only the
   carriageway rule applies to it. A gate that condemns a correct piece is how a
   gate teaches people to ignore it.
2. **Edge NAMES are not enough — offsets are the load-bearing measurement.**
   `road_curve` and `race_track_curve` have the same shape of `joins` and
   near-identical `lane`. Only where the carriageway meets each edge separates
   the valid sweeping turn from the unusable chicane.

## 8. Build order

1. `fitness.ts` / `fitness.mjs` + unit tests — the rule set, test-first.
2. Standing sweep over the existing library → the worklist that proves the rules
   find today's three known faults and do not flag known-good pieces.
3. Assets tab (table + live preview).
4. Blocking wire-in to `vendor-models.mjs`.
5. Resolve §7 with a render; fix the curve; re-publish.
6. Layer 2 (golden prompts) — last, as it is the most expensive and least urgent.

Steps 1–3 are the ones that would have caught all three of this week's faults.

### Status (2026-08-09)

- **Step 0 — DONE.** `scripts/render-assets.mjs` built; §7 resolved in §7b above.
  No asset needed fixing — all three faults were information faults.
- **Steps 1, 2 — DONE.** `src/lib/assets/fitness.ts` + `scripts/lib/fitness.mjs`
  (with `fitness.parity.test.ts` pinning the two copies together, reason text
  included), 20 tests. Sweep is `scripts/asset-fitness-sweep.mjs`; today it
  reads 10 pass / 1 needs-eyes (`road_ramp`, TECH_DEBT #95) / 1 fail
  (`race_track_curve`, TECH_DEBT #96).
- **Step 3 — DROPPED (owner decision 2026-08-09).** The `/admin/assets` page was
  the largest item in the plan and its whole value was "let a human look at an
  asset" — which the CLI render harness from step 0 already does at a fraction
  of the cost. Revisit if the sweep worklist ever grows past what a terminal
  can carry.
- **Step 4 — DONE.** Blocking `vendor-models.mjs` stage 5b. Assessed against the
  whole library (a kit's module is not knowable one file at a time) but blocking
  only on the batch being published — otherwise the first known-bad asset
  freezes the pipeline and the gate gets commented out.
- **Step 5 — n/a**, see §7b.
- **Step 6 (Layer 2, golden prompts) — NOT BUILT.** Still the only thing that
  can catch a fault where every asset is individually fine and the generated
  output is wrong, which is the exact shape of both race-track bugs. Now also
  the cheaper answer to TECH_DEBT #97 (prompt-token creep).
