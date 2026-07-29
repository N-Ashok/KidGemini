# PRD — Cricket Asset Batch (bat, ball, wicket, pitch, cricketer)

**Date:** 2026-07-29 · **Owner ask:** *"i want to download the 3d mesh figures
available for making a cricket game."*

## 1. Problem — and why the ask could not be met as phrased

There was nothing to download. A scripted license sweep of poly.pizza
(14 cricket terms, 2026-07-29; CC0 detected by the model page's license section
resolving to `creativecommons.org/publicdomain/zero`) found:

- **Zero CC0 cricket assets.** No bat, no ball, no stumps, no player. The only
  CC0 hits on those searches were false friends: *"Tree Stump with Moss"*, and
  *"Wooden Bat Barbed/Saw"* (zombie-apocalypse melee weapons).
- **Only two cricket assets at ANY license** — two CC-BY bats
  (`/m/dsxJlJxS-49`, `/m/vyq1I4lrfr`) and nothing else. So unlike every previous
  batch, **relaxing the CC0 policy would not have helped**: the ball, stumps and
  player simply do not exist in the free 3D pool.

This is the same wall the 2026-07-26 sports batch hit for soccer, and it has the
same remedy: author the set ourselves and dedicate it CC0.

Rejected deliberately: the CC0 **baseball bats** (`/m/i2JCd3w8gh` et al). A
round bat reads as the wrong sport instantly — the flat blade *is* the cricket
bat, and reusing a baseball mesh would look like a bug to any kid who plays.

## 2. Tech Feasibility

Cricket equipment is simple, axis-aligned geometry — easier to author than the
soccer set that preceded it:

1. **Equipment** (bat, ball, wicket, pitch, sight screen) is boxes and revolved
   solids, buildable with the existing flat-shaded vertex-colour `meshBuilder()`
   in `scripts/author-first-party-models.mjs`. All land 2.6–8.8 KB, far under
   the 150 KB model budget.
2. **The player** re-uses the proven footballer route: Kenney character-b with a
   re-painted atlas. `retexture-footballer.py` gains a `whites` kit that drains
   BOTH jersey and trousers to white (the existing code already drained the
   trousers for football shorts, so this is one branch). Mesh and rig untouched
   → the cricketer inherits the full blocky-character clip set, so the
   people-clips prompt line stays true for it.
3. **Pipeline fit:** all first-party models use the existing `kind: 'local'`
   source class. Nothing downstream changes.

## 3. Tech Plan

- `scripts/author-first-party-models.mjs`: `cricketBat`, `cricketBall`,
  `wicket`, `cricketPitch`, `sightScreen`, `buildCricketer`, plus a shared
  `lathe()` helper factored out of the battle-top code.
- `scripts/retexture-footballer.py`: `whites` kit.
- `scripts/vendor-models.mjs`: 6 `local` entries + `trophy` (a genuine CC0 find).
- `src/lib/assets/asset-taxonomy.ts`: 7 entries in the existing `sports` genre.
- `src/lib/assets/model-select.ts`: cricket words added to the sports trigger.
- `src/lib/assets/gallery.ts`: 7 emoji.

### 3b. Real-world dimensions, because the render pass caught two errors

Models are authored at **1 unit = 1 metre** and to regulation size, which is
what makes a scene look right without the model guessing scale:

| Model | Size | Regulation |
|---|---|---|
| `cricket_bat` | 0.11 × 0.85 × 0.06 m | max 0.108 m wide, 0.965 m long |
| `cricket_ball` | 0.074 m diameter | 0.0716–0.0730 m |
| `wicket` | 0.225 × 0.748 m | 0.2286 m wide, 0.71 m stumps + bails |
| `cricket_pitch` | 3.05 × 20.12 m | 10 ft × 22 yd |

**Two defects the render pass caught, neither of them a size-budget failure:**

1. The ball's seam was authored as two latitude bands of a 10-ring sphere — 36°
   of arc, which rendered as a **beach-ball stripe**, not a stitch line. Fixed to
   a single band of a 16-ring sphere (~11°).
2. The wicket was 0.144 m wide — **a ball could pass between the stumps**. The
   spacing was arithmetic done from the wrong number; fixed to regulation.

Neither would have been caught by the byte budget, the contract tests, or a
thumbnail. This is the second batch running where the render pass is the gate
that earns its keep.

## 4. Use Cases

| # | Use case | How tackled |
|---|---|---|
| 1 | "Make a 3D cricket game" | `cricket` trigger unlocks; catalog teaches bat, ball, wicket, pitch, cricketer |
| 2 | "Bowl at the stumps and knock the bails off" | `wicket` is ONE model including bails, so a game places a whole wicket in a single `loadModel` — and the bails are separate geometry to animate off |
| 3 | Batting animation | `cricketer` carries the blocky rig, so `attack-kick-*` (the footballer's kick clips) and `interact-right` are available as bat-swing stand-ins |
| 4 | A full field of players | `cricketer` + the 20 existing people models; all share one rig and clip set |
| 5 | "Who won?" screen | `trophy` (CC0, genuinely available) |
| 6 | Kid says "batsman" / "stumps" / "googly" | All in the trigger; `batsman`/`bowler`/`fielder` also reach `cricketer` via tags |
| 7 | A football ask also surfaces cricket gear | Accepted: cricket shares the `sports` GENRE, and genres are the unit of selection. The static catalog teaches the whole library anyway, so this changes nothing in practice (pinned by test, with the reasoning recorded) |

## 5. Test list

- taxonomy: all 7 present and in `sports`; the **cricketer carries the Kenney
  rig** while the equipment does not (a bat has no walk clip); kid vocabulary
  reaches the set via tags.
- model-select: cricket / batsman / bowler / stumps asks pick the set; a
  non-sports ask picks none of it.
- rig set: 20 → **21** updated deliberately — the cricketer is a genuine re-skin,
  so the shared-clip promise holds.

## 6. Out of scope

Pads, gloves, helmet and boots (the blocky character has no accessory slots —
they would need atlas work with no visible payoff at this poly count); a stadium
bowl (`grandstand` covers it); bowling/batting-specific animation clips; a
scoreboard model (2D HTML overlay is better and free); and a cricket playbook
clause in the prompt — the physics playbook already covers ball flight, bounce
and spin, which is most of what a cricket game needs.
