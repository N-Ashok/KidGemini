// Backfill `facing` and `realSize` into the model manifest (2026-08-15).
//
// WHY (owner: "the llm is not getting the axis, size, direction correct"):
//
// FACING — the prompt asserted "VEHICLES/CHARACTERS face +Z" with nothing
// per-model behind it. A top-down render audit (scripts/render-assets.mjs)
// disproved it: `car` faces -Z, `airplane` faces +X, `small_plane` faces -Z,
// `bird` faces +X, `elephant` faces -X, while most road vehicles, bikes and
// animals do face +Z. A bounding box cannot express a direction, so before
// this table nothing anywhere could tell a game which way a model points and
// every game re-guessed it (TECH_DEBT #91).
//
// REALSIZE — the catalog mixes two scale systems: 238 of 296 sized models are
// raw kit units while 58 are real metres, because only a handful of vendor
// entries carry `normalizeLongest`. By `size` alone a mountain (1.9) is
// smaller than a car (2.56) and a house (1.3 wide) is narrower than one, yet
// the prompt called it all "REAL metres". `realSize` is the real-world figure,
// shipped ALONGSIDE `size` (never replacing it — live games already divide by
// `size`, and redefining it would silently change their arithmetic).
//
// READ THIS BEFORE ADDING ROWS:
//   * `facing` is MEASURED, one model at a time, off a top-down render. Add a
//     row only for a model whose front you can actually SEE. A model whose
//     facing is ambiguous (a canoe pointed at both ends, a tank whose turret
//     and hull disagree, a rocket that points up) MUST stay absent — absent
//     means "unknown" and the runtime then leaves rotation alone, which is
//     strictly better than a confident wrong answer.
//   * `realSize` is CURATED knowledge, not a measurement, and it is a design
//     choice as much as a fact — a stylised kit house is not a surveyed house.
//     These are first-pass figures chosen to make objects believable NEXT TO
//     EACH OTHER, which is the actual failure being fixed.
//
//   node scripts/backfill-facing-and-real-size.mjs [--write]
//
// Without --write it reports what would change and touches nothing.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repo, "src/lib/assets/manifest.json");

/** Audited 2026-08-15 from top-down renders. Only models whose front is
 *  unambiguous in the render appear here. */
const FACING = {
  // ── road vehicles ────────────────────────────────────────────────────────
  // `car` is the odd one out, and it is the name a racing game reaches for
  // first — this single row is the most-used wrong value in the catalog.
  car: "-z",
  taxi: "+z", police: "+z", sedan: "+z", sports_car: "+z", hatchback: "+z",
  suv: "+z", luxury_suv: "+z", van: "+z", delivery_van: "+z", truck: "+z",
  pickup_truck: "+z", ambulance: "+z", firetruck: "+z", garbage_truck: "+z",
  tractor: "+z", armored_truck: "+z", tank_toy: "+z",
  // At FULL SIZE the hull and turret do NOT disagree (the contact-sheet tile
  // was too small to tell): the hull is X-long and the barrel points along it.
  // This is the hull at rest — the turret rotates in play, which is the game's
  // business, not the asset's.
  tank: "-x",
  // Added 2026-08-15 (second pass). These were first left unaudited as
  // "seat/nose ambiguous from above" — a judgement made from a 12-up contact
  // sheet where each tile was ~200px. At FULL SIZE the karts are unambiguous:
  // the driver's visor and the front bumper face +Z, the twin exhausts sit at
  // -Z. Leaving them out was the costliest gap in the first pass: a child's
  // "Candy Kingdom Racer" used `race_kart`, got null from modelFacing, and
  // hand-guessed `rotation.y = Math.PI` — which is the kart driving backwards
  // at the camera in the owner's screenshot. Lesson: audit the models a GENRE
  // depends on at full size, whatever the sheet suggests.
  race_kart: "+z", gokart: "+z",
  future_car: "-z", // same F1 shape as `car`: wide rear wing at +Z, nose at -Z
  // ── two-wheelers (handlebars/forks south in every render) ────────────────
  sport_bike: "+z", race_bike: "+z", dirt_bike: "+z", cruiser_bike: "+z",
  chopper_bike: "+z", police_bike: "+z", scooter: "+z", moped: "+z",
  delivery_bike: "+z", mini_bike: "+z",
  // ── air / water ─────────────────────────────────────────────────────────
  airplane: "+x",      // nose east — 90 degrees off the assumed convention
  small_plane: "-z",   // propeller north
  fighter_jet: "+z", helicopter: "+z", spaceship: "+z", boat: "+z",
  // ── animals ─────────────────────────────────────────────────────────────
  elephant: "-x",      // trunk west
  bird: "+x",          // beak east
  dino: "+z", cat: "+z", dog: "+z", fish: "+z", shark: "+z", chicken: "+z",
  bat: "+z", dolphin: "+z", bee: "+z", deer: "+z", stag: "+z", wolf: "+z",
  fox: "+z", horse: "+z", donkey: "+z", snake: "+z", frog: "+z", panda: "+z",
  lion: "+z", tiger: "+z", dragon: "+z", crocodile: "+z",
  // ── characters (blocky kit: top-down nose shading and the 3/4 view agree) ─
  man: "+z", woman: "+z", girl: "+z", scientist: "+z", police_officer: "+z",
  pirate: "+z", grandpa: "+z", explorer: "+z", hero: "+z", alien: "+z",
  ghost: "+z",
  // Added 2026-08-15 (third pass, usage-weighted). Scanning every stored game
  // for loadModel() calls showed `cricketer` is the 8th most-used model in the
  // library (79 uses) and had NO facing — the same gap that made a child's
  // kart drive at the camera. Both are the blocky character kit, verified in
  // the 3/4 view against `explorer`, which was audited from two views.
  cricketer: "+z", plumber: "+z",
};

/** Deliberately NOT given a facing, and why — so the next person does not
 *  "helpfully" fill these in from the same renders I already looked at. */
export const FACING_DELIBERATELY_ABSENT = {
  canoe: "pointed at both ends — no front",
  rocket: "points up (+Y); no horizontal heading",
  ufo: "radially symmetric",
  tank_desert: "authored X-long, see TECH_DEBT #91 — needs its own decision",
  tank_rusty: "authored X-long, see TECH_DEBT #91",
  armored_pickup: "cab/bed could not be told apart from above",
  digger: "blade vs cab ambiguous from above",
  motorcycle: "no handlebar visible in the render",
  military_motorbike: "handlebars ambiguous",
  zebra: "head/tail could not be told apart from above",
  monkey: "3/4 view leaves the face between -X and +Z; a single view cannot decompose it",
  robot: "arms out, head not resolvable from above",
};

/** Real-world metres [x, y, z]. First-pass curation, chosen so objects look
 *  right BESIDE EACH OTHER. Reviewable and deliberately conservative: only
 *  models whose scale is obviously and materially wrong, plus the common
 *  companions they get placed next to. */
const REAL_SIZE = {
  // ── buildings: the worst offenders (kit units ~1-3 where reality is 8-150) ─
  house: [8, 6, 10], family_house: [9, 6.5, 11], bungalow: [10, 4.5, 12],
  cottage: [7, 5.5, 9], town_house: [7, 9, 10], dark_house: [8, 6, 10],
  porch_house: [9, 6, 11], modern_house: [12, 6, 14], modern_villa: [16, 7, 18],
  stilt_house: [8, 7, 10], garage_house: [11, 5.5, 12],
  office_building: [30, 40, 30], office_small: [16, 12, 16],
  office_wide: [34, 14, 20], office_block: [26, 24, 26], long_office: [40, 16, 20],
  flats: [22, 20, 18], garden_apartment: [24, 12, 18], apartment: [20, 26, 18],
  narrow_tower: [14, 45, 14], skyscraper: [40, 150, 40], glass_tower: [34, 120, 34],
  mall: [60, 12, 80], shop: [12, 7, 14], antenna_tower: [8, 60, 8],
  castle_gate: [14, 16, 6], siege_tower: [6, 14, 6], watchtower: [5, 12, 5],
  // ── landscape ───────────────────────────────────────────────────────────
  mountain: [400, 600, 400], mountain_small: [180, 220, 180],
  mountain_range: [1200, 700, 900], snow_mountain: [900, 700, 900],
  cliff: [40, 60, 25], hill_block: [40, 25, 40], hill_slope: [48, 25, 40],
  hill_corner: [40, 25, 40],
  // ── trees & plants ──────────────────────────────────────────────────────
  tree: [5, 9, 5], pine: [4.5, 12, 4.5], small_tree: [3, 5, 3],
  snow_pine: [4, 11, 4], snow_birch: [3.5, 13, 3.5], snow_dead_tree: [2.5, 8, 2.5],
  palm_tree: [5, 9, 5], palm_tree_tall: [6, 14, 6], jungle_tree: [8, 22, 8],
  savanna_tree: [10, 12, 10], cactus: [1.2, 3.5, 1.2], bamboo: [1.5, 12, 1.5],
  toadstool: [0.6, 0.9, 0.6],
  // ── vehicles ────────────────────────────────────────────────────────────
  car: [1.8, 1.2, 4.4], taxi: [1.8, 1.5, 4.6], police: [1.9, 1.5, 4.8],
  sedan: [1.8, 1.5, 4.7], sports_car: [1.9, 1.3, 4.5], hatchback: [1.8, 1.5, 4.1],
  suv: [2.0, 1.8, 4.8], luxury_suv: [2.0, 1.8, 5.1], van: [2.0, 2.2, 5.2],
  delivery_van: [2.1, 2.4, 5.5], truck: [2.5, 3.2, 8.5], pickup_truck: [2.0, 1.9, 5.4],
  ambulance: [2.2, 2.6, 5.8], firetruck: [2.5, 3.2, 9.0], garbage_truck: [2.5, 3.2, 9.0],
  tractor: [2.2, 2.8, 4.5], gokart: [1.2, 1.0, 2.0], race_kart: [1.2, 1.0, 2.0],
  future_car: [2.0, 1.3, 4.8], digger: [2.6, 3.0, 6.5],
  tank: [3.6, 2.4, 7.0], armored_truck: [2.6, 3.0, 7.0],
  // ── two-wheelers (already close; kept for consistency of the family) ─────
  sport_bike: [0.8, 1.2, 2.1], dirt_bike: [0.85, 1.2, 2.1], scooter: [0.7, 1.1, 1.8],
  // ── aircraft & boats ────────────────────────────────────────────────────
  airplane: [36, 12, 38], small_plane: [11, 3.5, 8], fighter_jet: [11, 4, 15],
  helicopter: [3, 3.5, 13], boat: [2.5, 2, 6], canoe: [0.9, 0.5, 4.5],
  // ── animals ─────────────────────────────────────────────────────────────
  elephant: [2.0, 3.2, 4.5], lion: [1.0, 1.2, 2.2], tiger: [1.0, 1.1, 2.4],
  crocodile: [0.9, 0.5, 4.0], horse: [0.8, 1.7, 2.4], donkey: [0.6, 1.3, 1.8],
  zebra: [0.8, 1.5, 2.2], deer: [0.7, 1.4, 1.9], stag: [0.9, 1.7, 2.1],
  wolf: [0.5, 0.9, 1.5], fox: [0.35, 0.5, 1.0], dog: [0.35, 0.6, 1.0],
  cat: [0.25, 0.35, 0.7], panda: [0.9, 1.2, 1.6], monkey: [0.4, 0.9, 0.5],
  chicken: [0.25, 0.4, 0.4], shark: [1.2, 1.4, 4.5], dolphin: [0.8, 1.0, 2.6],
  dino: [2.0, 4.0, 6.0], frog: [0.2, 0.12, 0.25], snake: [0.2, 0.15, 2.0],
  // ── people (a person is the reference every other size is judged against) ─
  man: [0.5, 1.8, 0.35], woman: [0.45, 1.7, 0.32], girl: [0.35, 1.35, 0.25],
  scientist: [0.5, 1.8, 0.35], police_officer: [0.55, 1.85, 0.38],
  pirate: [0.55, 1.8, 0.38], grandpa: [0.5, 1.7, 0.35], explorer: [0.55, 1.8, 0.38],
  soldier: [0.55, 1.8, 0.38], hero: [0.55, 1.85, 0.38],
  // ── added 2026-08-15, usage-weighted ────────────────────────────────────
  // Chosen by scanning every stored game for loadModel() calls: these are the
  // props children actually place most, and every one of them was missing a
  // real size. `cricketer` and `plumber` measure 2.70m tall in catalog units,
  // which is why a person ends up towering over a house.
  cricketer: [0.5, 1.8, 0.35], plumber: [0.5, 1.75, 0.35],
  star: [0.4, 0.4, 0.15], coin: [0.3, 0.3, 0.05], heart: [0.35, 0.35, 0.15],
  gem: [0.25, 0.3, 0.25], chest: [0.8, 0.6, 0.5], crate: [0.9, 0.9, 0.9],
  rock: [1.2, 0.9, 1.1], spring: [0.4, 0.5, 0.4], apple: [0.08, 0.09, 0.08],
  banana: [0.05, 0.05, 0.18], traffic_cone: [0.35, 0.7, 0.35],
  finish_line: [8, 5, 1.2], grandstand: [24, 9, 8],
  cricket_bat: [0.11, 0.96, 0.06], cricket_ball: [0.07, 0.07, 0.07],
  wicket: [0.23, 0.71, 0.05], cricket_pitch: [3.05, 0.02, 20.12],
  sight_screen: [10, 6, 0.5], soccer_ball: [0.22, 0.22, 0.22],
  soccer_goal: [7.32, 2.44, 2], toadstool: [0.5, 0.7, 0.5],
  low_fence: [2, 1, 0.1], garden_path: [1, 0.02, 1],
  tank_toy: [0.3, 0.2, 0.5], spaceship: [8, 3, 12], dragon: [6, 4, 9],
  monkey: [0.4, 0.9, 0.5], fish: [0.08, 0.12, 0.25],
};

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const byName = new Map(manifest.assets.filter((a) => a.type === "model").map((a) => [a.name, a]));

const write = process.argv.includes("--write");
let facingAdded = 0, facingChanged = 0, realAdded = 0, unknown = [];

for (const [name, facing] of Object.entries(FACING)) {
  const entry = byName.get(name);
  if (!entry) { unknown.push(name); continue; }
  if (entry.facing === facing) continue;
  if (entry.facing) { facingChanged++; console.log(`  facing ${name}: ${entry.facing} -> ${facing}`); }
  else facingAdded++;
  if (write) entry.facing = facing;
}

for (const [name, realSize] of Object.entries(REAL_SIZE)) {
  const entry = byName.get(name);
  if (!entry) { unknown.push(name); continue; }
  if (JSON.stringify(entry.realSize) === JSON.stringify(realSize)) continue;
  realAdded++;
  if (write) entry.realSize = realSize;
}

// A real-size that is wildly out of step with the measured size is a typo in
// the table above, not a discovery — flag it rather than shipping it.
for (const [name, realSize] of Object.entries(REAL_SIZE)) {
  const entry = byName.get(name);
  if (!entry?.size) continue;
  const ratio = Math.max(...realSize) / Math.max(...entry.size);
  if (ratio > 400 || ratio < 0.02) {
    console.log(`  ! ${name}: realSize is ${ratio.toFixed(0)}x the measured size — check this row`);
  }
}

console.log(`\nfacing:   +${facingAdded} added, ${facingChanged} changed, ${Object.keys(FACING).length} audited`);
console.log(`realSize: +${realAdded} added, ${Object.keys(REAL_SIZE).length} curated`);
console.log(`deliberately left unknown: ${Object.keys(FACING_DELIBERATELY_ABSENT).length} (see FACING_DELIBERATELY_ABSENT)`);
if (unknown.length) console.log(`not in manifest (ignored): ${[...new Set(unknown)].join(", ")}`);

if (write) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nwrote ${manifestPath}`);
} else {
  console.log(`\n(dry run — pass --write to apply)`);
}
