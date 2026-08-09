# PRD — Animals, Hills & Snow/Ski Assets (2026-08-09)

**Owner ask:** "I need more CC0 3D meshes and wired. on animals like crocodile,
elephats, deer, monkey, lion, tiger and also hills and snow mountains, sking
environment, etc"

**Owner decisions taken before any code (2026-08-09):**

1. **First-party CC0 authoring** for every subject with no CC0 source — *not*
   the CC-BY unlock the motorcycle batch introduced. This batch therefore adds
   **no new attribution surface**: no new credit-chip models, no new authors.
2. **Build the category-map hybrid** for the prompt catalog rather than raise
   the token ceiling a fourth time.
3. **Full batch (~30 models)**, covering jungle/safari animals AND the snow,
   hills and ski environment in one pass.

**Shipped:** 38 models, all CC0 — 24 vendored downloads, 14 authored first-party —
plus one pipeline **bug fix** that this batch's measurements uncovered and that
reaches back across the whole library (§ Tech Feasibility).

---

## Tech Feasibility

### The sourcing sweep (2026-08-09)

A licence-filtered scan of poly.pizza's search index (its `licence` field, read
per result) across ~35 terms — crocodile, elephant, deer, monkey, lion, tiger,
bear, wolf, fox, horse, gorilla, giraffe, zebra, hippo, rhino, alligator, camel,
buffalo, penguin, snow, mountain, hill, ski, ski lift, skier, chairlift, sled,
snowmobile, iceberg, igloo, snowman, terrain, island, winter, ice — plus
inspection of the actual Kenney kit zips.

**The pool splits cleanly in two:**

| Wanted | CC0 available? | Outcome |
|---|---|---|
| deer, stag | ✅ Quaternius | vendored |
| wolf, fox, horse, donkey, zebra, panda, snake, frog | ✅ Quaternius | vendored (adjacent to the ask, same rig) |
| mountains, snow trees/bush/rock, ice, snowflake | ✅ Quaternius | vendored |
| hills, cliffs | ✅ Kenney nature-kit | vendored |
| **a snow-capped mountain** | ❌ (`mountain` is a 1.9 m grey rock with a fleck) | **authored first-party** |
| snowboard | ✅ Geldvillager | vendored |
| **crocodile, elephant, lion, tiger, monkey** | ❌ **zero** | **authored first-party** |
| **skis, poles, sled, chairlift, lift tower, slalom gate, igloo, snowman** | ❌ **zero** | **authored first-party** |

The five animals the owner named FIRST are exactly the ones with no CC0 source:
poly.pizza's entire big-cat / jungle / ski shelf is the **CC-BY Google-Poly
archive** (elephant: 32 results, 0 CC0; tiger: 32 results, 0 CC0), and Kenney's
`animal-pack` / `animal-pack-remastered` are **2D sprites only** — no GLB in the
zip. `tiny-ski` is likewise a 2D tilemap. This is the fifth consecutive batch to
hit this wall (sports, cricket, Indian games, motorcycles), and the remedy is
the established one, now taken deliberately instead of via CC-BY: author them.

### The bug this batch found (and why it matters far past this batch)

Every animated candidate probed **~260–320 KB** — over the 150 KB budget — and
the library's own comments record the same verdict going back to 2026-07-13:
*"Rejected as over-budget: Shiba Inu ~241 KB, Husky ~266 KB, both Quaternius
horses ~305 KB (mesh-heavy, and simplify() no-ops on skinned meshes)"*, plus
Panda ~177 KB and Penguin ~154 KB.

**That diagnosis was wrong.** The deer measured 261,728 B with three clips kept
and 261,664 B with ONE — keepAnimations was doing essentially nothing. Byte
accounting on the output showed 813 accessors in a file with **zero** animations
and 394 KB of bufferViews for a 4,276-vertex mesh: `Animation.dispose()`
detaches its channels and samplers but does **not** dispose them, so their
input/output accessors keep a live reference, `prune()` cannot collect them, and
**every clip the model ever had is written into the published GLB.**

Disposing channels and samplers before the animation (`vendor-models.mjs`) —
plus dropping the duplicate armature-prefixed clip each Quaternius rig ships —
turns that into:

| model | before | after |
|---|---|---|
| deer | 261.7 KB ✗ | **113.3 KB** ✓ |
| stag | 261.9 KB ✗ | **108.6 KB** ✓ |
| wolf | 266.7 KB ✗ | **93.4 KB** ✓ |
| fox | 262.4 KB ✗ | **91.4 KB** ✓ |
| horse | 321.7 KB ✗ | **120.8 KB** ✓ |
| donkey | 304.6 KB ✗ | **115.2 KB** ✓ |
| panda | 178.5 KB ✗ | **86.6 KB** ✓ |
| zebra | 72.4 KB | **23.4 KB** |
| frog | 108.8 KB | **65.9 KB** |

So the animated-animal shelf was never out of reach — a five-line leak had been
pricing it out for a year. Logged in `docs/BUG-FIX-LOG.md` (2026-08-09).
**Not done here:** re-vendoring the models already published under the leak.
Their bytes are permanent (§10 immutability), so shrinking them means new
hashes, new URLs and a manifest re-point — a separate, separately-approved
change. Registered as tech debt.

### Budget results

All 38 land under the 150 KB budget; the heaviest is `deer` at 113.3 KB and the
authored meshes are 3–13 KB each (flat-shaded vertex colours, no textures).

---

## Tech Plan

### 1. Sourcing & pipeline (`scripts/vendor-models.mjs`)

- 24 CC0 entries added: 10 animals, 9 snow/mountain props, 1 snowboard,
  4 Kenney nature-kit hill/cliff pieces.
- **Clip-leak fix** + **duplicate-clip drop** (above), commented at the call
  site with the measured before/after so it cannot be "tidied" away.
- `assertLongAxis: 'z'` on the five authored animals — the catalog promises
  characters face +Z, and the lint is what keeps that promise true.

### 2. First-party authoring (`scripts/author-first-party-models.mjs`)

A shared `quadrupedBase()` skeleton — barrel body, neck, head with snout, four
legs, tail — with every variant dimension as a named option and an
`extras(b, o)` hook for the signature parts. Same shape as the motorcycle
generator, for the same reason: ten near-identical builders drift, one skeleton
with ten option sets does not.

- **elephant** (6.1 m) — swept-back ear slabs, tapered curling trunk, tusks.
- **lion** (2.8 m) — mane ring of blocks, tail tuft.
- **tiger** (3.0 m) — seven wrapped stripe bands, ringed tail.
- **crocodile** (4.5 m) — level neck, long snout, teeth, eyes ON TOP of the
  head, 12 tapering back/tail scutes.
- **monkey** (0.93 m) — built directly, not as a quadruped: upright ape with
  arms past the knees and a curled tail.
- **ski gear** — skis, ski_poles, sled, chairlift, ski_lift_tower, slalom_gate,
  igloo, snowman.
- **snow_mountain** (28 m) — added after the first golden ski run rendered
  brown wedges: Quaternius' `mountain` is a 1.9 m grey rock peak with a single
  white fleck, which is not what a kid means by "snow mountain". Rock below a
  jagged snowline, snow above, deterministic ridge jitter (never Math.random —
  a re-run must be byte-identical or the content-hash name changes).

Convention: nose/front = +Z, up = +Y, feet at y = 0, symmetric about x = 0, real
metres — so the elephant really does tower over the 2 m Kenney cars.

### 3. Prompt catalog — the category-map hybrid

Measured split before this batch: **2,522 tokens = 1,802 prose + 720 names**
(264 models at ~2.7 tokens each). The ceiling is 2,525 and the test beside it
says *"THE NEXT RAISE SHOULD NOT HAPPEN"*; +38 names is ~+105 tokens, which
breaches it. Per the owner decision, the hybrid is built rather than the ceiling
raised a fourth time.

**Design (preserves the caching contract that the static catalog exists for):**
the byte-stable system instruction keeps the RULES and the category headings
with counts; the exact names for the categories this turn's ask touches ride at
the END of the request contents, not in the system instruction. Everything
before the injected block is unchanged, so the Gemini prefix cache still hits on
the whole system prompt; and because the block is a pure function of the stored
message text + manifest, history turns reproduce byte-identically.

The 2026-07-24 regression this must not reintroduce ("make me a fun game"
triggered nothing, so the model was taught 6 of 106 models and hand-rolled cubes
for a pizza restaurant) is guarded by: headings + counts always present, a broad
default spread when nothing triggers, and models the current game already uses
always included.

### 4. Selection / curation wiring

Taxonomy entries for all 38, a **snow / winter** genre (own genre, not folded
into `nature`: a snow scene wants snow trees and mountains, and dragging cactus
and palm trees into a ski game is exactly the over-triggering the cricket and
Indian-games triggers document), the `animals` trigger extended with the named
species, gallery cards + emojis, and `modelSize` for every static piece.

### 5. Instruments built for this batch

- `render-assets.mjs --staged` — renders the **compressed bytes about to be
  uploaded**, from disk, via a blob URL through the real engine + decoder. A new
  batch could not be eyeballed at all before: it has no URL until it is
  published, and publishing is the irreversible step that must not happen before
  a human has looked. (Rule 12: build the instrument, don't use the owner's UAT.)
- The 3/4 view now frames on height as well as XZ footprint — the 7.5 m lift
  tower and the upright monkey were cropped to unreadable close-ups.

**What the render pass caught that no number would have:** the snowman's stick
arms pointed up-and-back (built with `strut()`, which draws in the YZ plane at a
fixed x); the tiger's tail rendered cream-grey because `dark` doubles as its
muzzle colour; and snow_mountain's ridge jitter was not periodic, so its last
column never met its first and the mesh flapped open at the seam. All fixed and
re-rendered.

**And one the instrument itself got wrong:** `--staged` picked the FIRST
hash-named build of a model, not the newest — so a re-render after an edit
returned the pre-edit mesh and reported it as the fix. A lying instrument is
worse than none; it now takes the newest by mtime.

**Dropped from the batch:** `ground_grass`. It is a zero-thickness plane
(1 × 0 × 1 m) and the manifest validator rightly refuses it — `modelSize().y = 0`
makes "stand something on top of this" meaningless. A flat ground is what
`PlaneGeometry` is for, and the catalog already teaches it. Its bytes are on the
host (append-only) and simply unreferenced.

### 6. Verified on the real path (CLAUDE.md §9.6 — not on a green suite)

Two new golden prompts (`golden/prompts.json`) run through the REAL generation
path on a live dev server, then through the browser verifier:

| prompt | result | models the model actually chose |
|---|---|---|
| "3D - make a skiing game down a snowy mountain with flags to go through" | runs clean, 7 assets, canvas drawn | skis, ski_poles, slalom_gate, snow_pine, snow_rock, snowman, explorer |
| "3D - make a jungle game with a crocodile and a monkey and an elephant" | runs clean, 6 assets, canvas drawn | crocodile, elephant, monkey, tree, rock, star |

Both were screenshotted and looked at: the ski game is a real 3D slope — skier
on red skis with poles, snow pines, snowmen, slalom gates receding into fog,
mobile steering buttons, gate scoring. This is the proof that the hybrid
delivers the new names end-to-end, since NONE of these models existed in the
prompt this morning and the names now arrive only via the retrieved block.

`snow_mountain` is retrieved for the ski ask (verified directly) but the model
did not choose it in this run — offering is the platform's job, choosing is the
model's.

**The golden runs are deliberately NOT marked accepted.** The ledger records who
looked; an unattributed "accepted" is worth nothing. That is the owner's call:
`node scripts/golden-prompts.mjs --accept snow-ski`.

**Fixed in the harness while using it:** `golden-prompts.mjs` called
`res.json()` on `/api/chat`, which streams NDJSON — it threw on the first delta,
so the harness had never completed a run since the streaming route landed.

---

## Use Cases

1. **"Make a jungle game with a crocodile and a monkey"** — `animals` trigger
   fires on both species; `crocodile` + `monkey` + `palm_tree` + `ground_grass`.
   All CC0 → no credit chip. *Tackled by:* first-party animals + taxonomy.
2. **"A safari game with elephants and lions"** — the elephant's real 6 m length
   means it dwarfs a jeep without per-model scale surgery. *Tackled by:*
   real-metre authoring + `modelSize`.
3. **"Tiger chasing a deer in the forest"** — pairs an authored tiger with the
   vendored animated deer; the deer carries Idle/Walk/Gallop so it visibly runs.
   *Tackled by:* the clip-leak fix, which is the only reason the deer fits.
4. **"Make a skiing game"** — new snow genre pulls `skis`, `ski_poles`,
   `slalom_gate`, `snow_pine`, `mountain`, `hill_slope`; the kid builds a run
   from slalom gates down a hill. *Tackled by:* the snow/winter genre.
5. **"A ski resort with a chairlift"** — `chairlift` + `ski_lift_tower` repeat
   up the slope; the chair's cable grip sits at the top so a game moves it along
   a line it draws itself. *Tackled by:* authored lift pieces.
6. **"Snowball fight outside an igloo"** — `igloo`, `snowman`, `snow_rock`,
   `ice_block`. *Tackled by:* the authored igloo/snowman.
7. **"A game with hills to climb"** — `hill_slope` / `hill_block` /
   `hill_corner` / `cliff` tile from one kit at one scale, the rule the race
   track bugs taught. *Tackled by:* Kenney nature-kit pieces + `modelSize`.
8. **"Horse riding game"** — `horse`, `white horse` ask answered by `horse` +
   `donkey` + `zebra`, all with Gallop. *Tackled by:* vendored Quaternius rig.
9. **A kid browsing /assets** — 38 new cards with 🐊🐘🦁🐅🐒⛷️🏔️ placeholders and
   magic words. *Tackled by:* gallery emojis + tags.
10. **A future batch wants a rigged first-party animal** — the authored meshes
    are rigid, so a kid's game animates them per catalog rule 7 (own primitive,
    or transform). Rigging first-party meshes is NOT in this batch and is the
    pointer for the next one. *Tackled by:* explicit note here.

---

## Scale ceilings

- **Prompt catalog:** the hybrid removes the per-name growth from the system
  prompt, so the library can grow past 300 models without touching the ceiling.
  What it does NOT solve is prose growth — the last three raises were all
  fault-driven rules, and that pressure is unchanged. Trigger to revisit: any
  raise above 2,525 that is not paid for by deleting the teaching it replaces.
- **The leak fix is not retroactive.** ~40 published animated models still carry
  their dead clip data (dino, cat, dog, chicken, bat, alien, soldiers, …). They
  cost kids' devices bandwidth that a re-vendor would return, but their bytes
  are permanent, so it is a manifest re-point, not a re-run. Registered as tech
  debt; trigger = the next time a load-time complaint or a mobile perf budget
  makes the bandwidth matter.
- **Authored animals are rigid.** No walk cycle, ever, until someone rigs them.
  Trigger to revisit: a kid asking why the lion doesn't move — the catalog's
  rule 7 fallback (drive your own primitive) is the interim answer.
- **Model budget stays 150 KB.** With the leak fixed, the animated Quaternius
  shelf now fits inside it with ~20 % headroom, so the pressure that would have
  forced a raise is gone.
