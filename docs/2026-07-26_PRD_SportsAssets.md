# PRD — Sports & Battle-Top Asset Batch (soccer + beyblade-style)

**Date:** 2026-07-26 · **Owner ask:** "3D beyblades, football, football players,
football-related items — find on the internet, place in the right place, add to
the LLM catalog." · **Owner decisions (recorded from the 2026-07-26 session):**
soccer (not American football) · generic battle tops (no Beyblade branding) ·
first-party CC0 authoring (no CC-BY policy change) · dry-run then `--upload`.

## 1. Problem

Kids ask for football and beyblade games; the library has zero sports assets, so
the model hand-rolls spheres and cubes. A sourcing sweep (2026-07-26) found **no
usable third-party models**:

- Every soccer item on poly.pizza (balls, goals, stadiums, all sport balls) is
  **CC-BY 3.0** (Google Poly archive) — `manifest.ts` validators refuse non-CC0
  library assets (PRD-3D-GAMES-AND-ASSETS §2.6/§4.1), and that policy stands.
  Sole CC0 find: a rugby ball (not soccer; skipped per owner decision).
- Kenney and Quaternius publish **no 3D sports kit at all** (catalog sweep of
  both sites).
- "Beyblade" models are fan-made meshes of a **trademarked Takara Tomy/Hasbro
  toy** (CC-BY, Sketchfab-login-gated, and branded — fails §4.2 "nothing
  branded" and kids-platform IP risk regardless of mesh license).

## 2. Tech Feasibility

The shapes are simple enough to author ourselves, and CC0 permits derivatives:

1. **Original meshes** (soccer ball, goal, two battle tops) are buildable
   programmatically with `@gltf-transform/core` (already a devDependency) using
   flat-shaded vertex colors — the same look as the Quaternius models. A
   truncated icosahedron (the classic black/white ball) is 32 faces / <200 tris;
   goal and tops are boxes/cylinders/cones. All land far under the 100 KB model
   budget. We hold copyright and dedicate them CC0 (`assets-src/LICENSE.md`).
2. **Football players**: Kenney Blocky Characters (CC0, already vendored, the
   only humanoids that fit the budget) allow modification. Re-painting a
   character's texture atlas into team jerseys yields `footballer` (red kit) and
   `footballer_blue` (blue kit) that inherit the shared `kenney_blocky` rig —
   walk/sprint/emote clips work day one, crowd + players share cached skeleton
   conventions. Atlas regions (head/torso/arms/legs) are cleanly separated, so a
   deterministic pixel recolor (Pillow) is reliable.
3. **Pipeline fit**: `vendor-models.mjs` gains a `local` source kind (copy from
   `assets-src/<name>/` instead of download). Everything downstream — compress,
   budget gate, hash-name, upload, verify, manifest — is unchanged. sourceUrl
   proof trail: kenney.nl asset page for the derivatives; the in-repo CC0
   dedication (GitHub URL) for originals.

## 3. Tech Plan

- `assets-src/` (new, committed): `LICENSE.md` (CC0-1.0 dedication for
  first-party assets) + generated model dirs (git-ignored; rebuilt by script).
- `scripts/author-first-party-models.mjs` (new): builds soccer_ball,
  soccer_goal, battle_top, blade_top GLBs; recolors character-b atlas into the
  two footballer texture variants (calls `scripts/retexture-footballer.py`).
  Deterministic output (append-only-host safe).
- `scripts/vendor-models.mjs`: add `kind: 'local'`; append 6 MODELS entries.
- `src/lib/assets/asset-taxonomy.ts`: new genre id `sports`; entries for the 6
  models (footballers carry `rig: "kenney_blocky"`).
- `src/lib/assets/model-select.ts`: GENRES entry `sports` (label
  "sports / football") with trigger
  `/\b(sports?|soccer|football(er)?s?|goals?|goal\s?keeper|penalt(y|ies)|kick(ing|s)?|striker|match(es)?|beyblades?|spinning\s?tops?|battle\s?tops?)\b/i`
  (final regex in code).
- Tests first: taxonomy/model-select/prompt-catalog extensions (see §5).
- Docs same-change: PRD-3D-GAMES-AND-ASSETS §4.1 (first-party source class),
  FEATURES.md, REGRESSION-TEST-CATALOG.md.

**Scale ceilings** (per CLAUDE.md §10): library 159 → 165 models; the binding
guard is the prompt-catalog token ceiling (≤1,500 tokens, pinned by test — one
new heading + 6 names ≈ +20 tokens). No new queries, state, or infra; the
asset host is append-only as before.

## 4. Use Cases

| # | Use case | How tackled |
|---|---|---|
| 1 | "Make a 3D football/soccer game" | `sports` trigger unlocks; catalog teaches soccer_ball, soccer_goal, footballer, footballer_blue; players animate via shared rig clips (sprint = run, interact = kick stand-in) |
| 2 | "A penalty shootout" | goal + ball + one footballer; goalkeeping via walk/idle clips |
| 3 | "Beyblade battle" / "spinning top arena" | battle_top + blade_top; games spin via `rotation.y` per frame — no rig needed; trigger covers "beyblade", "spinning top", "battle top" |
| 4 | "Football match with a crowd" | grandstand + people models (existing) + footballers; all share the rig clip set so the people-clips prompt line stays true |
| 5 | Kid names a model directly ("add a soccer_ball") | name-literal matching in `selectModelNames` and the static catalog both cover it |
| 6 | Model invents an unlisted sports name | unchanged fail-soft: unlisted names load nothing, placeholder shapes rule applies |

## 5. Test list

- taxonomy: entries exist for all 6; footballers in `modelsWithRig`
  (kenney_blocky set 18 → 20 — test updated deliberately, the clip promise
  holds because the meshes are re-skins of the same rig).
- model-select: "soccer game" / "beyblade battle" asks pick sports models, not
  sea creatures; sports genre has ≥1 manifest member.
- prompt-catalog: sports heading renders; every model still listed exactly
  once; token ceiling holds.
- pipeline: contract tests (`npm run test` on `src/lib/assets/`) as the vendor
  gate, per the existing stage-5 flow.

## 5b. Sports playbook (added same day, owner ask)

Models alone produced the "everyone chases the ball" game. `SPORTS_PLAYBOOK`
in `prompt-catalog.ts` now teaches the basic rules and dynamics whenever the
manifest's sports genre has members:

- **Team sports** (football, hockey, polo, handball — sport-agnostic): score
  in the opponent's goal, restart at centre, first-to-3/timer, visible score;
  one-chaser-only AI with the rest easing toward formation
  (`home + (ball − home) × 0.2`); keeper clamped to the goal mouth; kick =
  clip + velocity impulse, friction ×0.98/frame, no physics engine.
- **Duel games** (air hockey, pong-style, battle tops): paddles clamped to
  their own half, computer paddle speed-capped so kids can win; tops spin via
  `rotation.y += speed * delta` with decay and collision spin-steal.

**Caching:** the clause derives from the manifest only (never the message), so
`modelsPromptSection()` stays byte-identical per turn and the Gemini
prefix-cache contract holds (pinned by the existing byte-stability test).
**Cost:** ~250 tokens; the catalog token ceiling was raised 1500 → 1750 as the
documented revisit that test demands.

## 6. Out of scope

Stadium bowl mesh (grandstand covers it), referee character, American football
set (owner chose soccer), any CC-BY sourcing or attribution surface.
