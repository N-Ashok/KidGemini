# PRD — Military Asset Batch (tanks, vehicles, fortifications, soldiers, weapons)

**Date:** 2026-07-29 · **Owner ask:** "need more tanks and military 3D items to
be downloaded from internet — do the search and download and wire it."
· **Owner decisions (recorded from the 2026-07-29 session):** batch 1 shipped
vehicles + fortifications only; the owner then **reversed that scope the same
session** ("let there be soldiers, hand held weapons and grenade launchers …
it is all part of kids games these days" / "don't restrict"), so batch 2 adds
the soldiers and weapons — see §2b · per-model byte budget raised 100 KB →
150 KB so the realistic tanks can ship · dry-run, render pass, then `--upload`.

**36 models total**, in two batches: §3d (16 — vehicles + fortifications) and
§3e (20 — soldiers + hand-held weapons).

## 1. Problem

The library had 165 models and **zero military assets**. A kid asking for "a
tank game" — a genuinely common ask, and one the platform's own safety config
already blesses ("cartoon video-game action … tank games with bloodless
'pop/vanish' enemies is NOT violence", `src/lib/safety.config.ts`) — got
hand-rolled boxes. The `castle` genre covers fantasy siege (catapult,
trebuchet, ballista, battering_ram) but nothing modern.

## 2. Tech Feasibility

A scripted license sweep of poly.pizza (2026-07-29, 40 military search terms;
CC0 detected by the model page's license section resolving to
`creativecommons.org/publicdomain/zero`) found a deep usable seam — unlike the
sports sweep, **no first-party authoring is needed**:

1. **Quaternius' military pack is CC0 throughout**: 6 tanks, armored vehicles,
   turrets, cannons, sandbag trenches, guard towers, radar dish, chain fence,
   dome bunker. Kenney contributes a CC0 barricade.
2. **Pipeline fit**: every model is a direct CC0 GLB, so the existing
   `kind: 'url'` source class covers the batch. Compress → budget gate →
   hash-name → upload → verify → manifest are unchanged.
3. **Budget was the one real obstacle** — see §3b. Three of the four tanks
   needed pipeline work plus an owner-approved budget change.
4. **No gaps worth faking**: the CC0 pool has no jeep, humvee, APC, fighter
   jet, hangar or army tent anywhere. Ground cover comes from the armored
   vehicles; air is already served by `helicopter`, `rocket`, `spaceship`.

### 2b. Scope — soldiers and weapons ARE in scope (revised, same day)

The batch was first built vehicles-and-fortifications-only, with the CC0
soldiers and weapon props deliberately left out and a test guarding against
their addition. **The owner reversed that within the same session** — *"let
there be soldiers, hand held weapons and grenade launchers and quaternius. it
is all part of kids games these days"*, then *"don't restrict"*. Batch 2 (§3e)
vendors them; the ban test was replaced by one pinning the set that shipped.

This required **no safety-policy change**, which is the load-bearing point:
`src/lib/safety.config.ts` already reads *"fictional weapons inside a game a
child is making/playing are NOT dangerous acts"* and *"cartoon video-game
action (space shooters, sword adventures, tank games with bloodless
'pop/vanish' enemies) is NOT violence"*. The batch lands inside the existing
policy rather than moving it — no threshold relaxed, no category guide edited.

Rejected on the thumbnail pass, recorded so nobody re-adds them: `/m/j59k7ctnZM`
("Tank" — actually propane cylinders), `/m/Jzj8dz4Cj0` ("Short Cannon" —
actually a shotgun), the six Quaternius "Barracks" (fantasy-town temples, not
military), and two medieval stone watch towers (the library already has
`tower`).

## 3. Tech Plan

- `scripts/vendor-models.mjs`: 36 `kind: 'url'` MODELS entries; the tuple gains
  an optional 4th element for `simplifyRatio`, and `prepare()` gains a
  `dropMeshes` option (§3e).
- `src/lib/assets/asset-taxonomy.ts`: new genre id `military` + 36 entries, and
  a second rig id `quaternius_soldier` (§3e).
- `src/lib/assets/model-select.ts`: GENRES entry `military` (label "army /
  battle vehicles"). "soldier" and "gun" are **trigger words, not model
  names** in batch 1 — kids say them for a war game. After batch 2 they are
  both trigger words AND real models.
- `src/lib/assets/model-select.ts` also gains `soldierModels()`, mirroring
  `peopleModels()` for the new rig.
- `src/lib/assets/prompt-catalog.ts`: a soldier-clip clause (§3e).
- `src/lib/assets/gallery.ts`: 36 emoji.
- `src/lib/assets/manifest.ts`: `BUDGET_BYTES.model` 100 K → 150 K, kept in
  sync with `MODEL_BUDGET_BYTES` in the vendor script.
- Tests first (see §5).

### 3b. Two pipeline fixes this batch required

Both are general improvements, not batch special-cases:

1. **Strip the skin when no clips remain.** The tanks ship a rigged
   `TankArmature` with Forward/Backwards/TurningLeft/TurningRight drive clips.
   A kid's game drives a tank by moving `position`/`rotation`, never by playing
   a clip, so `keepAnimations: []` drops them — but `prune()` will not remove
   the now-dead Skin (the nodes still reference it), so `JOINTS_0`/`WEIGHTS_0`
   kept riding along in every vertex **and `simplify()` refused the primitives
   outright** (skinned meshes are its documented no-op — the Shiba Inu/horse
   rejection class). Stripping the skin when zero clips remain is worth ~12 KB
   per tank and is what makes `simplifyRatio` work on the armored vehicles at
   all. Guarded on "zero clips remain", so no rigged character is ever touched.
2. **`weld()` before simplify.** Merges vertices whose attributes already
   match (tolerance 1e-4): visually lossless, leaves the node hierarchy intact
   (a game can still find and rotate a tank's turret child), and it is
   `simplify()`'s prerequisite anyway. It is what brought `tank_rusty` from
   150,348 B — 348 B over the line — to 149.4 KB.

### 3c. The budget change (owner decision)

`BUDGET_BYTES.model` 100 K → **150 K**. The three realistic tanks land at
119.6 / 128.6 / 145.9 KB and are **irreducible**: they are flat-shaded, so weld
finds almost no collapsible edge and `simplify()` returns byte-identical output
at every ratio down to 0.25 (probed 2026-07-29). They ship at the new line or
not at all.

- **Worst case first load stays inside the §8 2 MB cap**: 650 K engine +
  5 × 150 K = 1.4 MB.
- This **deliberately re-opens** size rejections made on the old line. Re-checked
  every one recorded in `PRD-3D-GAMES-AND-ASSETS.md` §12: still over — Penguin
  ~154 KB, Bunny ~154 KB, Panda ~177 KB, Shiba ~241 KB, Deer ~260 KB, Fox
  ~263 KB, Husky ~266 KB, horses ~305 KB. **Newly eligible: Turtle ~128 KB** —
  not vendored here (out of scope for a military batch), logged as a
  free follow-up for whoever next fills out the `animals` genre. Those numbers
  also predate the §3b pipeline fixes, so the borderline pair (Penguin, Bunny at
  ~154 KB) may now fit too and is worth re-probing at that time.
- **Revisit trigger:** if a later batch needs a third raise, stop and fix the
  source meshes instead — 150 K × 5 models is already 71% of the first-load cap.

### 3d. The batch (all CC0, all thumbnail- and render-reviewed)

| Model | KB | Source |
|---|---|---|
| `tank` (olive), `tank_desert`, `tank_toy`, `tank_rusty` | 119.6 / 128.6 / 28.6 / 145.9 | Quaternius |
| `armored_truck`, `armored_pickup` | 126.5 / 124.9 | Quaternius |
| `turret`, `turret_cannon`, `cannon` | 27.7 / 25.3 / 20.4 | Quaternius |
| `sandbags`, `sandbags_small` | 34.0 / 18.6 | Quaternius |
| `bunker`, `watchtower`, `radar`, `chain_fence` | 33.1 / 8.3 / 15.7 / 80.1 | Quaternius |
| `barricade` | 13.7 | Kenney |

Four tanks is deliberate: a kid saying "my tank vs the enemy tank" needs two
distinct meshes, not one recolored at runtime.

### 3e. Batch 2 — soldiers + hand-held weapons (20 models)

| Model | KB | Note |
|---|---|---|
| `soldier`, `hazmat` | 135.8 / 140.0 | Quaternius `CharacterArmature` — a **different rig** from the Kenney people |
| `rifle`, `assault_rifle`, `sniper_rifle`, `shotgun`, `submachine_gun` | 15.0–27.2 | |
| `pistol`, `revolver`, `flare_gun` | 10.3–22.8 | |
| `rocket_launcher`, `grenade_launcher`, `bazooka` | 16.0 / 16.9 / 63.9 | bazooka is CreativeTrio's (classic shoulder tube) |
| `grenade`, `landmine`, `bullets` | 6.8–14.3 | |
| `laser_gun`, `space_rifle`, `space_pistol` | 20.1–45.1 | sci-fi variants, also in the `space` genre |
| `shield` | 19.6 | also `castle` |

Three further pipeline facts this batch established:

1. **`dropMeshes` (new option).** The Quaternius soldier files are whole KITS:
   each bundles a 12–14 mesh weapon rack (Sniper, SMG, AK, RocketLauncher,
   Knife…) parented to the hand bones, which is most of their 337–454 KB. We
   vendor those weapons as their own models, so the rack is pure waste.
   Dropping it takes `soldier` 337.5 KB → 135.8 KB.
2. **The soldiers get their own rig id** (`quaternius_soldier`). Their clips
   are `CharacterArmature|Run`, `Run_Gun`, `Idle_Shoot`… — nothing like the
   Kenney people's `sprint`/`emote-yes`. Sharing the existing rig id would
   make the catalog promise clips that do not exist.
3. **The prompt teaches the INTERSECTION, not the union.** `soldier` has no
   `Walk` clip; `hazmat` does. The clause therefore teaches Idle, Run,
   Run_Gun, Idle_Shoot, Jump, Wave, Death and says to use Run for all
   movement — pinned by a test, because promising a walk the model then
   cannot find is the exact failure the rig split exists to prevent.

Rejected in batch 2: `swat` (388.2 KB even clip-trimmed — dense body meshes,
and skinned meshes are `simplify()`'s no-op), `enemy_soldier` (186.1 KB with
the rack dropped AND cut to 4 clips — mesh-dominated), `ammo_box`
(192.7 KB — `bullets` covers the pickup), and `riot_shield`, which is a flat
near-black plane with no readable silhouette in 3D — **caught on the render
pass, not the byte budget**, which is exactly what that pass is for.

**Scale ceilings** (per CLAUDE.md §10): library 165 → 201 models. The binding
guard is the prompt-catalog token ceiling (≤1,750, pinned by test): both
batches add one heading + 36 names + the soldier-clip clause — measured after
wiring, see §7. Second guard is the §8 first-load cap, addressed in §3c.
No new queries, state, or infra; the asset host stays append-only.

## 4. Use Cases

| # | Use case | How tackled |
|---|---|---|
| 1 | "Make a 3D tank game" | `military` trigger unlocks; catalog teaches 4 tanks + forts; tanks drive by transform (no clips shipped, so nothing to mis-play) |
| 2 | "My tank vs the enemy tank" | Four visibly distinct tanks (olive / sand / yellow / rusty) give unambiguous sides without runtime recoloring |
| 3 | "Defend my base" / tower defence | `turret`, `turret_cannon`, `cannon` emplacements + `sandbags`, `barricade`, `chain_fence`, `watchtower`, `bunker` |
| 4 | "An army convoy" | `armored_truck` + `armored_pickup` + existing `truck`/`van`; both carry the `racing` genre too, so a convoy ask reaches them |
| 5 | "A soldier with a rifle" | `soldier`/`hazmat` + any of the 16 weapon props; the catalog tells the model the weapons are separate objects to parent onto a soldier (`soldier.add(gun)`) |
| 5b | "Space soldiers with laser guns" | `laser_gun`, `space_rifle`, `space_pistol` carry BOTH `military` and `space` genres, so a space ask reaches them too |
| 6 | Kid names a model directly ("add a bunker") | Name-literal matching in `selectModelNames` and the static catalog both cover it |
| 7 | Model invents an unlisted military name | Unchanged fail-soft: unlisted names load nothing, placeholder-shapes rule applies |
| 8 | A soldier is told to play a clip it lacks | The rig split + intersection-only clip clause (§3e) mean the prompt never names a clip that any soldier lacks; pinned by test |

## 5. Test list

- **taxonomy**: all 16 present in the manifest and in the `military` genre; ≥4
  tanks; none claims the `kenney_blocky` rig (no walk clip to promise); tags
  carry kid vocabulary (army, sandbag, lookout); **scope guard** — no soldier /
  rifle / sniper / bazooka / grenade / launcher / shotgun / pistol names.
- **model-select**: tank, army-and-soldier, and base-defence asks pick military
  models and not sea creatures; a non-military ask picks none.
- **prompt-catalog**: the military heading renders and names the tanks and the
  fortifications; no military model appears on the people-rig clip line; the
  existing token ceiling still holds.
- **pipeline**: contract tests (`npx vitest run src/lib/assets/`) as the vendor
  gate, per the existing stage-5 flow.
- **visual pass**: all 16 staged GLBs rendered through three + GLTFLoader +
  MeshoptDecoder before upload (the white-model failure class from the 2026-07-12
  gltfpack incident) — all correct.

## 6. Out of scope

Jeep/humvee/APC/fighter-jet (no CC0 source exists), tread or turret animation
clips (dropped on purpose — §3b), CC-BY sourcing, any safety-policy change
(§2b — none was needed), and a military playbook clause in the prompt (the
sports batch needed one because team AI is non-obvious; tank movement is not).

## 7. Outcome

Library 165 → 201 models (36 new, all CC0, all render-verified). Prompt catalog
measured at build time against the ≤1,750-token ceiling — see the value pinned
in `prompt-catalog.test.ts`.
