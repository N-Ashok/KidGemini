# PRD — 3D games: engine, asset gathering, and asset use in generated games

**Status:** Draft (2026-07-08). Phase 0 was built and reverted the same day
(commits `aa2cd33` + `c0966c2`, reverted in `cf391d5`) — the code is intact in
git history and this PRD is the plan for bringing it back and extending it
with real 3D assets. Parent product doc: `PRD.md` (F5 — game artifacts).

## Problem

Kids ask for "a racing game" or "a dino game" and get flat 2D canvas
rectangles. Real 3D (a road that stretches into the distance, a ball that
rolls through a maze) is a step-change in how impressive the result feels —
but generated games must stay **single-file, offline, and permanent** once
published to the Arcade (CloudFront/S3 static files, no external requests),
so we can't just link a CDN or fetch models at runtime.

## Goals

1. The model can build genuinely 3D games (camera, lighting, depth) when the
   game idea calls for it — 2D canvas stays the default.
2. Games can use a small set of good-looking, kid-friendly 3D models (a car,
   a dino, a tree…) instead of only primitive boxes and spheres.
3. Every generated game remains ONE self-contained HTML file with zero
   external resources, before and after publishing.
4. No licensing risk: every embedded asset is CC0 (public domain) — no
   attribution requirements we'd have to carry inside kids' games.

## Non-goals

- Textures/skyboxes from image files, physics engines, multiplayer.
- Letting kids upload or import their own models (moderation surface; later).
- Photorealism — the bar is "delightful low-poly", not AAA.

## Phase 0 — Three.js primitives (BUILT, reverted; re-introduce first)

Everything below already exists in git history and needs only re-application
plus the deploy fix that its production failure taught us:

- **Opt-in marker:** the model emits `<!--USES_THREE-->` and writes
  `import { ... } from "three"` in a `<script type="module">`. The curated
  import list lives in `CHILD_SYSTEM_PROMPT` (`src/lib/gemini.ts`): primitive
  geometries (Box/Sphere/Cone/Cylinder/Plane/Torus/Capsule/Ring), basic
  materials, lights, `PerspectiveCamera`, `WebGLRenderer`.
- **Vendored, not CDN:** `scripts/vendor-three.mjs` bundles the `three` npm
  package with esbuild into one tree-shaken, import-free ES module embedded
  as a base64 `data:` URI behind an import map (`src/lib/three-vendor.ts`).
  Injected server-side in `api/chat/route.ts` ONLY when the marker is present
  (a ~500KB bundle baked into every 2D game forever would be dead weight).
- **⚠️ The lesson from production (BUG-FIX-LOG 2026-07-08):** `deploy-rsync`
  does not ship `src/` — the generated bundle under `src/lib/vendor/` was
  missing on EC2, `readFileSync` threw mid-stream, and previews silently died.
  Re-introduction MUST include both halves of `c0966c2`: ship
  `src/lib/vendor` in the deploy artifact list AND the route's try/catch
  fallback (a lost `done` event is never acceptable).

## Phase 1 — Curated CC0 model library (the new work)

### Gathering (build-time pipeline, not runtime)

- **Sources (CC0 only):** Kenney.nl asset packs, Quaternius packs, and
  poly.pizza filtered to CC0. No CC-BY (attribution inside generated games is
  a burden we don't want), no "free for personal use" licenses.
- **Curation criteria:** kid-friendly subject, low-poly (< ~5K triangles),
  reads well without textures or with baked vertex colors, looks good from a
  game camera (not just a turntable).
- **Starter set (~12–20 models, one per game archetype):** car, airplane,
  rocket, boat, dino, dog, cat, fish, tree, coin/gem, castle tower, robot.
- **Format:** GLB (binary glTF), meshopt/gltfpack-compressed, **budget ≤
  100KB per model** (enforced by a test, like the bundle tests). Stored in
  the repo under `src/lib/vendor/models/` next to the three bundle, each with
  a manifest entry: name, source URL, license proof, byte size.
- **Pipeline:** a `scripts/vendor-models.mjs` sibling of `vendor-three.mjs` —
  downloads/normalizes/compresses at build time on the dev machine, commits
  the generated `.glb` files. Runtime never fetches anything.

### Using (generation-time injection)

- The system prompt teaches a **named catalog** (`car`, `dino`, `tree`, …).
  The model requests assets with a second marker, e.g.
  `<!--USES_MODELS: car,tree-->`, and loads them in code via a tiny helper
  the injector provides (`loadModel("car")` → parses the embedded GLB).
- The injector (extending `three-vendor.ts`) embeds ONLY the requested
  models as base64 `data:` URIs — a game with a car doesn't carry the dino.
- Safety scan continues to run on the model's raw output BEFORE any
  injection, exactly as Phase 0 did.
- Prompt cost: the catalog adds ~1 line per model to `CHILD_SYSTEM_PROMPT`
  (~15–20 tokens each). At 20 models that's ~300–400 tokens per game-building
  message — acceptable, but the catalog does NOT grow unbounded (see
  ceilings).

## Scale ceilings & revisit triggers

- **Game file size:** three bundle (~500KB) + 3 models (≤300KB) ≈ 0.8–1MB per
  3D game HTML. Fine for CloudFront; revisit if games start embedding > 5
  models (introduce per-game size cap ~2MB, publisher-side check).
- **Catalog size:** hard cap 25 models in the prompt catalog. Beyond that,
  move selection to a retrieval step (model asks for a category, server maps
  to assets) rather than growing the prompt.
- **Repo/deploy weight:** 20 models × 100KB ≈ 2MB in the rsync artifact —
  negligible. Revisit if the library exceeds ~10MB (move to S3-sourced build
  cache).
- **1GB EC2 box:** injection is string concat at request time, no new
  processes; no memory-budget change (see platform `docs/MEMORY_BUDGET.md`).

## Testing contract (test-first, per repo rules)

- Per-model budget test: every manifest entry exists, is valid GLB magic,
  ≤ 100KB, and license field says CC0 with a source URL.
- Injection tests (extend `three-vendor.test.ts`): unmarked games pass
  through byte-identical; `USES_MODELS` embeds exactly the requested subset;
  unknown names fail soft (game still works without the model).
- Deploy test (restore `three-vendor.deploy.test.ts`): the ship-list includes
  `src/lib/vendor` — the class of the Phase-0 production failure.
- Prompt-contract test (restore `gemini.test.ts`): catalog names in
  `CHILD_SYSTEM_PROMPT` match the manifest exactly.

## Rollout

1. **Phase 0 re-introduction** (one change, then UAT): cherry-pick the 3D
   parts of `aa2cd33` + all of `c0966c2` (deploy fix), restore `gemini.ts`
   prompt additions incl. the `100dvh` sizing rule.
2. **Phase 1a**: pipeline + 5 models (car, dino, tree, coin, rocket), UAT.
3. **Phase 1b**: fill out to ~20 models, per-genre prompt hints, UAT.

## Open decisions (need explicit user sign-off before Phase 1 build)

1. Starter model list — which 5 first?
2. Per-model size budget: 100KB proposed; 50KB forces cruder models, 200KB
   allows nicer ones at bigger published files.
3. Marker syntax `USES_MODELS: a,b` vs. always bundling a fixed "starter kit"
   with `USES_THREE` (simpler prompt, heavier files).
