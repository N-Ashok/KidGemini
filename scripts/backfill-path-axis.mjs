// Backfill `pathAxis` onto manifest model entries that predate the field
// (2026-08-08 — docs/BUG-FIX-LOG.md, "poorly formed race track").
//
// WHY THIS EXISTS. vendor-models.mjs now declares pathAxis and writes it into
// the manifest, but it only reaches the manifest write on an --upload run.
// Unlike `size`, pathAxis is NOT measured from the bytes — it is a DECLARATION
// about a model's authored orientation, so there is nothing to re-derive and
// no artifact to verify against: the same declaration applied here is
// byte-for-byte the one vendor-models.mjs would write. Re-uploading unchanged
// assets to publish a hand-declared string would be an absurd price.
//
// The declarations below are the single source of truth shared with
// vendor-models.mjs (CITY_ROAD_AXIS + the racing-kit entries). They were
// established by two independent geometric probes on the PUBLISHED glbs —
// extrusion uniformity and raised kerb/railing runs. Where those probes
// disagreed (road_bridge) nothing is declared, deliberately: TECH_DEBT #93's
// rule is that a confidently-wrong value is worse than a missing one.
//
// One-off by design: after this, vendor-models.mjs writes pathAxis itself.
// Re-running is safe (idempotent) and doubles as a verification pass.
//
//   node scripts/backfill-path-axis.mjs          # report only
//   node scripts/backfill-path-axis.mjs --write  # update manifest.json

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repo, 'src/lib/assets/manifest.json');

/** name → 'x' | 'z' | 'none'. Keep in lock-step with vendor-models.mjs. */
const PATH_AXIS = {
  // City kit — the road runs along X.
  road_straight: 'x',
  road_ramp: 'x',
  road_crossing: 'x',
  // City kit hubs/corners — no single run axis. A real answer, not a gap.
  road_curve: 'none',
  road_intersection: 'none',
  road_roundabout: 'none',
  // Racing kit — the road runs along Z. Opposite the city kit; this
  // disagreement IS the bug this field exists to expose.
  race_track_straight: 'z',
  finish_line: 'z',
  race_track_curve: 'none',
  // road_bridge: deliberately absent — the two probes disagreed.
};

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const changed = [];
const already = [];
const missing = [];

for (const [name, axis] of Object.entries(PATH_AXIS)) {
  const entry = manifest.assets.find((a) => a.name === name && a.type === 'model');
  if (!entry) { missing.push(name); continue; }
  if (entry.pathAxis === axis) { already.push(name); continue; }
  entry.pathAxis = axis;
  changed.push(`${name} → ${axis}`);
}

for (const line of changed) console.log(`  set  ${line}`);
for (const name of already) console.log(`  ok   ${name} (already correct)`);
for (const name of missing) console.error(`  MISS ${name} — not a model entry in the manifest`);

if (missing.length) {
  console.error('\n✖ Some declared names are not in the manifest — fix the declaration, do not guess.');
  process.exit(1);
}
if (!process.argv.includes('--write')) {
  console.log(`\n${changed.length} entr${changed.length === 1 ? 'y' : 'ies'} would change. Re-run with --write to update manifest.json.`);
  process.exit(0);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('\n✓ manifest.json updated — run `npx vitest run src/lib/assets/` to gate it');
