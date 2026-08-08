// Backfill measured carriageway data onto the manifest's path pieces
// (2026-08-09 — docs/BUG-FIX-LOG.md, the second "poorly formed race track").
//
// WHY THIS EXISTS. `pathAxis` (2026-08-08) fixed the STRAIGHTS but answers
// 'none' for every corner and hub — a true answer to "which axis does it run
// along", and a non-answer to the only question that lets a model place a
// corner. With nothing to reason from, the generated track guessed rotations
// 0, -pi/2, pi, pi/2, and the curves never met the straights. No prompt could
// fix it: the information did not exist anywhere in the system.
//
// UNLIKE pathAxis, these values are MEASURED, not declared — from a top-down
// render of the PUBLISHED bytes (scripts/render-assets.mjs --json). The
// geometry cannot answer it: these tiles are flat single-material slabs with
// the road painted into the colormap, so the mesh is a rectangle whichever way
// the road runs, and two independent geometric probes both returned "(none)".
// The pixels are the only instrument that can see a painted road.
//
// The numbers below are pasted from that measurement rather than re-derived at
// run time, on the backfill-path-axis.mjs precedent: measuring needs a browser
// and a network, while the manifest write must stay small, reviewable and
// re-runnable. Re-running the renderer reproduces them exactly; `--verify`
// checks a fresh measurement against what is committed here.
//
// `kit` and `pathRole` are the two DECLARATIONS in this file, and are marked as
// such. Neither is derivable: finish_line is racing-kit but shares no prefix
// with it, and only a human can say that its 1.26 m width is verge overhanging
// the grass (prop) rather than a broken 1 m tile.
//
//   node scripts/backfill-tile-edges.mjs            # report only
//   node scripts/backfill-tile-edges.mjs --write    # update manifest.json
//   node scripts/backfill-tile-edges.mjs --verify FILE.json   # vs a fresh run

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repo, 'src/lib/assets/manifest.json');

/**
 * MEASURED by scripts/render-assets.mjs on 2026-08-09 against the published
 * bytes. `lane` is the drivable width in metres at scale 1; `joinOffsets` is
 * where the carriageway centre meets each edge, in metres from the piece's own
 * minimum on that edge's axis.
 *
 * `kit` and `role` are DECLARED (see header).
 */
const MEASURED = {
  // --- City kit: 1 m module, 0.81 m carriageway, roads run X -------------
  road_straight:     { kit: 'city',   role: 'tile', joins: ['-x', '+x'],             offsets: { '-x': 0.5, '+x': 0.5 },                          lane: 0.806 },
  road_crossing:     { kit: 'city',   role: 'tile', joins: ['-x', '+x'],             offsets: { '-x': 0.5, '+x': 0.5 },                          lane: 0.806 },
  road_intersection: { kit: 'city',   role: 'tile', joins: ['+z', '-x', '+x'],       offsets: { '+z': 0.5, '-x': 0.5, '+x': 0.5 },                lane: 0.806 },
  // A 2x2 SWEEPING turn, not a one-cell corner: it joins the west edge in its
  // first cell (0.50 m) and the south edge in its second (1.50 m). Both are
  // cell centres, so it tiles correctly — the 2026-08-08 game's fault was
  // scaling it by gridSize/2, which halved its carriageway against the
  // straights it met.
  road_curve:        { kit: 'city',   role: 'tile', joins: ['+z', '-x'],             offsets: { '+z': 1.504, '-x': 0.496 },                       lane: 0.81 },
  road_roundabout:   { kit: 'city',   role: 'tile', joins: ['-z', '+z', '-x', '+x'], offsets: { '-z': 1.5, '+z': 1.5, '-x': 1.5, '+x': 1.5 },     lane: 0.813 },
  // Runs Z while every other city piece runs X. Long undeclared (TECH_DEBT
  // #93) because the two geometric probes disagreed; the render settles it —
  // its centre line runs plainly north-south. Until now a game mixing
  // road_bridge with road_straight laid the bridge crosswise, every time.
  road_bridge:       { kit: 'city',   role: 'tile', joins: ['-z', '+z'],             offsets: { '-z': 0.504, '+z': 0.504 },                       lane: 0.843, pathAxis: 'z' },
  // DELIBERATELY has no measurement written. From directly above, a ramp's
  // sloped side skirts are the same grey as its tarmac, so the probe reads all
  // four edges and a 1.00 m lane — both wrong. Recording that would be the
  // confidently-wrong value TECH_DEBT #93 exists to refuse. It stays on the
  // fitness worklist as `needs-eyes` until a human settles it.
  road_ramp:         { kit: 'city',   role: 'tile' },

  // --- Racing kit: 1 m module, 0.70 m carriageway, tracks run Z ----------
  race_track_straight:    { kit: 'racing', role: 'tile', joins: ['-z', '+z'], offsets: { '-z': 0.5, '+z': 0.5 },       lane: 0.697 },
  // The fix for the 2026-08-08 track. Mates race_track_straight exactly: same
  // 1 m module, same 0.70 m carriageway, joins dead on the cell centre.
  race_track_corner:      { kit: 'racing', role: 'tile', joins: ['+z', '+x'], offsets: { '+z': 0.5, '+x': 0.5 },       lane: 0.697 },
  race_track_corner_wide: { kit: 'racing', role: 'tile', joins: ['+z', '+x'], offsets: { '+z': 0.496, '+x': 0.496 },   lane: 0.698 },
  // The name lies (TECH_DEBT #96). Measured: it enters the north edge at
  // 0.50 m and leaves the south edge at 1.00 m — a CHICANE (lateral shift),
  // not a corner, and 1.00 m is a cell BOUNDARY on the 1 m grid, so nothing
  // on-grid can follow it. Its 1.5 m width is off-module too. Left in the
  // manifest with honest data so the fitness sweep names it rather than
  // hiding it; the prompt catalog no longer offers it for turns.
  // pathAxis corrected 'none' -> 'z' here. 'none' was declared on 2026-08-08
  // on the belief that this was a corner, and a corner genuinely has no run
  // axis. It is not a corner: it runs along Z and shifts sideways, so 'z' is
  // the true answer. The correction matters beyond tidiness — while the
  // declaration contradicted the measurement, the fitness rules distrusted the
  // measurement and withheld the cell-boundary finding that is the sharpest
  // evidence against this piece.
  race_track_curve:       { kit: 'racing', role: 'tile', joins: ['-z', '+z'], offsets: { '-z': 0.498, '+z': 1.002 },   lane: 0.7, pathAxis: 'z' },
  // A PROP, not a tile: the gantry straddles the road. Its 1.26 m width is
  // verge hanging over the grass and is correct — held only to the 0.70 m
  // carriageway, which it matches exactly. The 2026-08-08 game scaled it x10
  // while scaling straights x20, giving a 7 m gantry over a 20 m road.
  finish_line:            { kit: 'racing', role: 'prop', joins: ['-z', '+z'], offsets: { '-z': 0.63, '+z': 0.63 },     lane: 0.698 },
};

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const changed = [];
const already = [];
const missing = [];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const [name, m] of Object.entries(MEASURED)) {
  const entry = manifest.assets.find((a) => a.name === name && a.type === 'model');
  if (!entry) { missing.push(name); continue; }
  const before = JSON.stringify(entry);
  entry.kit = m.kit;
  entry.pathRole = m.role;
  if (m.pathAxis) entry.pathAxis = m.pathAxis;
  if (m.joins) {
    entry.joins = m.joins;
    entry.joinOffsets = m.offsets;
    entry.lane = m.lane;
  }
  if (JSON.stringify(entry) === before) already.push(name);
  else changed.push(name);
}

const verifyIdx = process.argv.indexOf('--verify');
if (verifyIdx >= 0) {
  const fresh = JSON.parse(readFileSync(process.argv[verifyIdx + 1], 'utf8'));
  let drift = 0;
  for (const [name, m] of Object.entries(MEASURED)) {
    if (!m.joins || !fresh[name]) continue;
    if (!same(fresh[name].joins, m.joins) || !same(fresh[name].offsets, m.offsets) || fresh[name].lane !== m.lane) {
      console.error(`  DRIFT ${name}`);
      console.error(`        committed ${JSON.stringify({ joins: m.joins, offsets: m.offsets, lane: m.lane })}`);
      console.error(`        measured  ${JSON.stringify({ joins: fresh[name].joins, offsets: fresh[name].offsets, lane: fresh[name].lane })}`);
      drift++;
    }
  }
  if (drift) {
    console.error(`\n✖ ${drift} piece(s) no longer measure the way this file records. The published bytes`);
    console.error('  changed, or the probe did. Settle it with a render before touching the manifest.');
    process.exit(1);
  }
  console.log('✓ every committed measurement reproduces from a fresh render');
  process.exit(0);
}

for (const name of changed) console.log(`  set  ${name}`);
for (const name of already) console.log(`  ok   ${name} (already current)`);
for (const name of missing) console.error(`  MISS ${name} — not a model entry in the manifest`);

if (missing.length) {
  console.error('\n✖ Some named pieces are not in the manifest — fix the declaration, do not guess.');
  process.exit(1);
}
if (!process.argv.includes('--write')) {
  console.log(`\n${changed.length} entr${changed.length === 1 ? 'y' : 'ies'} would change. Re-run with --write to update manifest.json.`);
  process.exit(0);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('\n✓ manifest.json updated — run `npx vitest run src/lib/assets/` to gate it');
