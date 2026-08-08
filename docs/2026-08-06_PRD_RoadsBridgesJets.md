# PRD — Roads, Bridges & Jets Assets (2026-08-06)

**Owner ask:** "more roads, long bridges, sky bridges, flying jets" —
same-day follow-up to the motorcycle batch
(`docs/2026-08-06_PRD_MotorcycleAssets.md`), riding the CC-BY attribution
wiring that batch built.

**Shipped: 19 models**, live on the asset host, manifest/taxonomy/gallery/
triggers wired, all contract tests green.

| group | names | source | license |
|---|---|---|---|
| Roads (9) | `road_straight`, `road_curve`, `road_intersection`, `road_crossing`, `road_roundabout`, `road_ramp`, `road_bridge`, `bridge_pillar`, `highway_sign` | Kenney city-kit-roads (new kit, pinned zip) | CC0 |
| Bridges (4) | `wooden_bridge` (Quaternius), `truss_bridge` (CreativeTrio) | poly.pizza | CC0 |
| | `suspension_bridge` (Steren Giannini), `elevated_road` (Jarlan Perez) | poly.pizza | CC-BY 3.0 |
| Jets/planes (6) | `fighter_jet`, `airplane` (jeremy), `small_plane` (Vojtěch Balák), `seaplane` (Neil M), `biplane` (Jake Blakeley), `private_jet` (Eik Røgeberg) | poly.pizza | CC-BY 3.0 |

## Tech Feasibility

- **Roads:** Kenney's **city-kit-roads** (70 assets, CC0, per-piece GLBs) is
  the right source — the poly.pizza "Modular Road Kit"/"Road Bits" listings
  ship whole kits as ONE mesh and were rejected. The kit's `road-slant`
  (ramp) + `bridge-pillar` + `road-bridge` pieces are what let a kid BUILD a
  flyover/sky bridge from parts. Kenney tiles are 1-unit modules (same
  convention as the already-vendored race-track/city pieces) — left at kit
  scale deliberately; games tile + scale them.
- **Long bridge / sky bridge:** the CC0 pool has small bridges only; the
  CC-BY unlock supplies the Golden-Gate-style `suspension_bridge` (a whole
  scene: water + shore + towers, shipped 9.4 m long → normalized to 50 m) and
  the twin-deck `elevated_road` flyover (→ 15 m).
- **Jets:** the 2026-07-13 sweep note ("No CC0 fixed-wing airplane or fighter
  jet exists…") described the **CC0** pool; the CC-BY pool is rich. Six
  distinct reads picked after thumbnail + render review. Rejected: X-Wing /
  Arwing / Macross fan art (branded, §4.2); every Google-Poly jet ≥ 1 MB raw
  and flat-shaded (simplify() no-op class — same as the motorcycle batch's
  rejections).
- All 19 landed 11–56 KB compressed — nothing near the 150 KB budget.

## Tech Plan

1. **Pipeline:** one new Kenney kit pinned (city-kit-roads, zip cached);
   poly.pizza entries use the same `url` kind; CC-BY entries carry
   `license`/`author` (credits chip wiring from the motorcycle PRD applies
   as-is — nothing new needed). `normalizeLongest` fixes author scales
   (seaplane shipped 1.6 m, airliner 37.6 m — kept ≈ real: fighter 14 m,
   airliner 36 m, Cessna 10 m, seaplane 8 m, biplane 7 m, bizjet 13 m).
2. **Taxonomy:** roads → racing+city; bridges → city/racing/nature/water as
   fits; jets → space (+military for `fighter_jet`). Tags carry the words
   kids say (flyover, skybridge, zebra, cessna, airforce…). No brand tags.
3. **Triggers:** racing += roads/highways/flyovers/ramps; city += bridges/
   flyovers; space += airplane/aircraft/airport/airforce/aeroplane/runway/pilot.
4. **Gallery:** 19 emoji entries (🛣️🌉🛩️✈️…).
5. **Verified:** every model rendered from its compressed bytes via the
   headless harness (far-plane bumped for the 50 m bridge); upload-then-verify
   green; 399 asset tests green including the 2300-token catalog ceiling
   (measured just under — the next batch MUST do the category-map hybrid).

## Use Cases

1. **"3d car race on a highway"** — racing trigger (highway) → road pieces +
   cars + `highway_sign`; tiles snap 1-unit-module style. *Tackled by:* roads
   set + trigger words.
2. **"Drive over a long bridge"** — `suspension_bridge` (50 m span) reads as
   THE long bridge; CC-BY chip credits Steren Giannini automatically.
   *Tackled by:* normalization + credits chip.
3. **"Sky bridge / flyover game"** — `elevated_road` is the ready-made
   flyover; `road_ramp` + `bridge_pillar` + `road_bridge` build custom ones.
   *Tackled by:* taxonomy tags (skybridge, flyover) + city/racing triggers.
4. **"Flying jet game" / "airforce game"** — space trigger fires; catalog
   offers `fighter_jet` (also in military beside the tanks). Rigid mesh — the
   catalog's item 7 teaches the spun-propeller/transform-flight pattern.
   *Tackled by:* jets set + space/military genres.
5. **"Land the plane at the airport"** — `airplane` + `road_straight` strips
   as runway (or racing kit's `finish_line`); airport/runway trigger words
   route it. *Tackled by:* trigger additions.
6. **"A river with a wooden bridge in the forest"** — `wooden_bridge` lives
   in nature+castle, beside `canoe`/`pine`. *Tackled by:* taxonomy genres.
7. **"Stunt plane show"** — `biplane` (the classic stunt silhouette) + stunt
   trigger word (added in the motorcycle batch). *Tackled by:* tags.
8. **Kid browsing /assets** — 19 new cards, magic words like "3d fighter
   jets"; CC-BY cards show the artist credit up front. *Tackled by:* gallery
   wiring.
9. **A game mixing jets and the city** — jets at real-world metres sit
   sanely beside the 2 m cars and the towers; no 15 m-wide-bike-class
   surprises. *Tackled by:* normalizeLongest.
10. **Next asset batch** — the catalog is at the 2300 ceiling; this PRD and
    the motorcycle PRD both bind the next sizeable batch to the category-map
    hybrid (headings static, names retrieved) instead of another raise.
    *Tackled by:* scale-ceilings note below.

## Scale ceilings

- **Prompt catalog: AT the 2400-token ceiling** (raised 2350 → 2400 on
  2026-08-08 for the rewritten sizing rule; measured 2398). The raise bought
  *fault-driven teaching that also deleted the wrong teaching it replaced*, not
  catalog room. The hybrid fallback (headings static, names retrieved) is still
  REQUIRED before the next sizeable ASSET batch.
- ~~Kenney road tiles are 1-unit modules by design; if kids' games consistently
  fail to scale them, revisit with a `normalizeLongest` pass.~~ **RESOLVED
  2026-08-08 — and the diagnosis here was half wrong.** Games did consistently
  fail to scale them (a racer laid 1 m tiles 10 m apart), but the tiles were
  never the problem: measurement confirmed the city road kit is already
  centre-origin and on an exact whole-metre module (1 m straight/intersection/
  crossing/ramp/bridge, 2 m curve, 3 m roundabout). A `normalizeLongest` pass
  would have **shrunk the curve's turn radius and made it worse**. The actual
  gap was that the sizes reached the LLM nowhere — fixed by shipping measured
  metres in `window.AR_SIZES` + `modelSize(name)`. See BUG-FIX-LOG 2026-08-08.
- **The racing kit was the one with a real defect** (found while fixing the
  above): `race_track_straight`/`race_track_curve` ship arbitrary origins —
  a perfect 1 × 1 m tile whose origin sat 1.15 m off in Z. Fixed with a new
  `recenterXZ` bake + a build-failing centring lint. **Reaches prod only on the
  next `--upload` run of those two entries** (append-only; published games keep
  their old URLs).
- The credits chip still covers models only (TECH_DEBT #89).
