# PRD — Indian Games & Sports Asset Batch (kabaddi, carrom, kho-kho, badminton, ludo, marbles)

**Date:** 2026-07-30 · **Owner ask:** "add more 3D models of popular games and
sports; popular among Indian kids in the age group of 7 to 14." · **Owner
decisions (recorded from the 2026-07-30 session):** batch covers kabaddi,
carrom, kho-kho, badminton, ludo, and marbles (goli) · cricket excluded — a
full cricket set (bat, ball, wicket, pitch, sight screen, cricketer, trophy)
already shipped 2026-07-29 · prefer sourced CC0 models when available, fall
back to first-party authoring only when nothing usable exists (same policy as
every prior batch).

## 1. Problem

Kids ask for games that are actually popular in India — kabaddi, carrom,
kho-kho, badminton, ludo — and the library has zero coverage. A sourcing
sweep (2026-07-30) across poly.pizza (CC0 filter only), Kenney.nl, and
Quaternius.com found **no usable third-party models for any of the six**:

- **Kabaddi:** no court/mat model on any site; the sport has no distinctive
  equipment beyond a marked rectangular mat.
- **Carrom:** poly.pizza's CC0-filtered "carrom" search returns zero results;
  the only board found was a paid Sketchfab pack, out of scope (non-CC0).
- **Kho-Kho:** no CC0 hits for the field poles that fit the aesthetic
  (candidates were fence posts / streetlights — wrong look and wrong
  license).
- **Badminton:** the only poly.pizza hit (`/m/b16JgIa8wRM`, Poly by Google) is
  **CC-BY** — confirmed on its own page, rejected per policy. No net or
  shuttlecock at any license.
- **Ludo:** poly.pizza's CC0 filter returns zero board hits; the one clean
  "Dice" hit is also **CC-BY**, rejected.
- **Marbles:** no CC0 hits — the nearest matches (Quaternius "Pebble Round",
  "Mineral") are rock-textured, not glass marbles, and read as the wrong
  object.

Kenney and Quaternius publish no South-Asian games content at all — same gap
the soccer (2026-07-26) and cricket (2026-07-29) batches hit. This is now a
established pattern for the region: **author first-party, dedicate CC0.**

## 2. Tech Feasibility

Every item is simple, flat-shaded, axis-aligned or revolved geometry —
comparable to the cricket set, buildable with the existing `meshBuilder()` /
`lathe()` helpers in `scripts/author-first-party-models.mjs`:

1. **Kabaddi:** `kabaddi_mat` — a flat rectangle (13m × 10m regulation court)
   with a painted centre lane line via vertex colour. `kabaddi_player` reuses
   the proven re-skin route (Kenney character-b atlas, new `kabaddi` kit —
   a sleeveless vest look, same drain-trousers-to-shorts technique as
   football/cricket whites) — inherits the full blocky-character rig and clip
   set day one.
2. **Carrom:** `carrom_board` (flat square with four corner pocket cutouts,
   diagonal guide lines via vertex colour), `carrom_striker` (flat wide
   cylinder), `carrom_coin_white` / `carrom_coin_black` (thin cylinders,
   colour-only variants of one mesh), `carrom_queen` (thin cylinder, red).
3. **Kho-Kho:** `kho_kho_pole` (a simple cylinder-and-cap post, used twice
   per field — one model, placed at both ends), `kho_kho_lane_field` (a flat
   rectangle with painted cross-lanes). `kho_kho_player` re-skins the same
   Kenney rig (reuses the `kabaddi` kit look — both sports share the
   sleeveless-vest silhouette in real life; no separate kit needed).
4. **Badminton:** `badminton_racket` (thin lathe-revolved handle + a flat
   oval hoop with a low-poly "strung" cross-hatch via vertex colour, not
   real string geometry), `shuttlecock` (a cone of thin triangular "feathers"
   fanned around a small hemisphere base — the recognisable birdie silhouette
   at very low poly count), `badminton_net` (a flat panel with a top band,
   posts as two thin cylinders).
5. **Ludo:** `ludo_board` (flat square, four coloured quadrant regions via
   vertex colour, centre home triangle), `ludo_dice` (a cube with pip dots as
   small flattened spheres/discs per face — reused from the existing die
   convention if one already exists in the library; otherwise authored
   fresh since the sourced CC0 dice all failed license check), `ludo_pawn`
   (a simple cone-on-disc peg shape, colour-variant per player — four colour
   variants of one mesh, matching the coin pattern).
6. **Marbles:** `marble` — a single UV sphere with a glossy/swirl vertex-colour
   material; `marble_blue` / `marble_green` as colour variants of the same
   mesh (matching the coin/pawn colour-variant pattern already established).

**Pipeline fit:** all first-party models use the existing `kind: 'local'`
source class in `vendor-models.mjs` — nothing downstream (compress, budget
gate, hash-name, upload, verify, manifest) changes.

## 3. Tech Plan

- `assets-src/` (existing, committed): extend `LICENSE.md` coverage — no
  change needed, it already covers all first-party assets generically.
- `scripts/author-first-party-models.mjs`: add build functions for all ~18
  models above; reuse `meshBuilder()`/`lathe()`; colour-variant meshes (coins,
  pawns, marbles) share one geometry builder parameterised by vertex colour,
  not duplicated code.
- `scripts/retexture-footballer.py`: add a `kabaddi` kit (sleeveless vest,
  drains sleeves + trousers per the existing branch pattern used for
  `whites`).
- `scripts/vendor-models.mjs`: append ~18 `local` entries.
- `src/lib/assets/asset-taxonomy.ts`: new genre id `indian_games` (kept
  separate from `sports` since kabaddi/carrom/ludo/marbles aren't "sports" in
  the same sense cricket/football are — carrom and ludo are tabletop games).
  `kabaddi_player`/`kho_kho_player` carry `rig: "kenney_blocky"`.
- `src/lib/assets/model-select.ts`: new `indian_games` GENRES entry (label
  "Indian games") with a trigger covering kabaddi, carrom (+ striker/coin/
  queen), kho-kho, badminton (+ shuttlecock/birdie/racket), ludo (+ pawn/
  dice/token), and marbles (+ goli).
- `src/lib/assets/gallery.ts`: emoji per model (reuse closest existing emoji
  where no exact one exists, e.g. 🎯 for striker, ⚪ for coin, 🪀 as a
  placeholder look for pawn if no better fit).
- Tests first: taxonomy / model-select / prompt-catalog extensions (see §5).
- Docs same-change: `PRD-3D-GAMES-AND-ASSETS.md` §4.1 (first-party source
  class — already documents the pattern, just needs no change beyond
  confirming this batch follows it), `FEATURES.md`,
  `REGRESSION-TEST-CATALOG.md`.

**Scale ceilings** (per CLAUDE.md §10): library sits at ~165 models after the
soccer + cricket batches; this adds ~18 more (~183). The binding guard remains
the prompt-catalog token ceiling (currently 1,750, raised once already for the
sports genre) — a new genre heading + 18 names is a meaningfully bigger
addition than prior batches (+250–350 tokens estimated) and **may require
raising the ceiling again**; this must be measured by the pinned
byte-stability/token test during implementation, not assumed.

## 4. Use Cases

| # | Use case | How tackled |
|---|---|---|
| 1 | "Make a kabaddi game" | `indian_games` trigger unlocks; catalog teaches `kabaddi_mat`, `kabaddi_player`; raid/tag mechanic uses existing people-clip conventions (sprint = run, tag = interact clip) |
| 2 | "Carrom game — flick the striker" | `carrom_board` + `carrom_striker` + `carrom_coin_white/black` + `carrom_queen`; striker motion is velocity + friction decay, same physics-playbook pattern as the battle-top spin |
| 3 | "Kho-kho chase" | `kho_kho_pole` (×2) + `kho_kho_lane_field` + `kho_kho_player`; tag/chase AI mirrors the kabaddi raider pattern |
| 4 | "Badminton rally" | `badminton_racket` + `shuttlecock` + `badminton_net`; shuttlecock arc uses the existing physics playbook's projectile/bounce logic, tuned for higher drag (feather shape implies slow-falling arc in the prompt, not new physics code) |
| 5 | "Ludo board game" | `ludo_board` + `ludo_dice` + `ludo_pawn` (×4 colour variants); turn-based board-game logic is new prompt guidance, not a new physics system |
| 6 | "Marbles game" | `marble` (+colour variants); rolling/flicking physics reuses the existing ball/friction pattern from cricket_ball and carrom_striker |
| 7 | Kid names a model directly ("add a carrom board") | name-literal matching in `selectModelNames` and the static catalog both cover it, as with every prior batch |
| 8 | Model invents an unlisted name | unchanged fail-soft: unlisted names load nothing, placeholder-shapes rule applies |

## 5. Test list

- taxonomy: all ~18 entries exist and sit in `indian_games`; `kabaddi_player`/
  `kho_kho_player` in `modelsWithRig` (rig set count updated deliberately,
  same as the football/cricket precedent); coin/pawn/marble colour variants
  each resolve to a distinct manifest name.
- model-select: "kabaddi", "carrom", "kho-kho", "badminton", "ludo", "marbles"/
  "goli" asks each pick their own set and not each other's or `sports`'s.
- prompt-catalog: new genre heading renders; every model listed exactly once;
  token ceiling test either holds or is deliberately raised with the
  documented revisit note (per CLAUDE.md §10 scale-ceiling rule).
- pipeline: contract tests (`npm run test` on `src/lib/assets/`) as the
  vendor gate, per the existing stage-5 flow.
- render pass: dimensions checked against real-world regulation sizes where
  one exists (carrom board 74×74 cm, badminton racket ~67 cm, ludo board
  proportions) — the cricket batch found two real defects (beach-ball seam
  stripe, wicket gap) that only the render pass caught, so this step is not
  optional.

## 6. Out of scope

Dedicated playbook clauses beyond reusing the existing physics/sports
playbook patterns (a full Ludo turn-based-game playbook is a bigger prompt
addition and can follow in a later PRD if kid usage shows it's needed);
kabaddi/kho-kho scoring-line/lobby rules beyond the raid/chase mechanic
already covered; any CC-BY sourcing or attribution surface; a stadium/crowd
model for kabaddi or kho-kho (no regulation precedent for one, unlike
cricket's grandstand reuse); actual upload to `assets.ariantra.com` — this
PRD covers authoring + dry-run only, the `--upload` step requires separate
explicit go-ahead per deploy-adjacent-action policy.
