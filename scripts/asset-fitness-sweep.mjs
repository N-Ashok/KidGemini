// The standing asset-fitness sweep (docs/2026-08-08_PRD_AssetFitnessAndReview.md
// §4 Layer 1, build step 2). Runs the rules over the WHOLE committed library,
// including assets shipped long ago, and prints a worklist with the evidence.
//
// Not a blocker for history — a to-do list (owner decision §2.3: earlier assets
// are in scope; grandfathering known-bad pieces optimises for keeping the gate
// green rather than for the child). The BLOCKING copy of these same rules runs
// inside scripts/vendor-models.mjs for anything being published.
//
// Pure and instant: no browser, no network, no model call. The measurements it
// reads were taken once by scripts/render-assets.mjs and committed by
// scripts/backfill-tile-edges.mjs.
//
//   node scripts/asset-fitness-sweep.mjs           # worklist
//   node scripts/asset-fitness-sweep.mjs --all     # include clean passes
//   node scripts/asset-fitness-sweep.mjs --strict  # exit 1 if anything fails

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assessLibrary } from './lib/fitness.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repo, 'src/lib/assets/manifest.json'), 'utf8'));
const models = manifest.assets.filter((a) => a.type === 'model');

const findings = assessLibrary(models);
const showAll = process.argv.includes('--all');

const ICON = { pass: '✓', 'needs-eyes': '?', fail: '✖' };
const ORDER = { fail: 0, 'needs-eyes': 1, pass: 2 };

const shown = findings
  .filter((f) => showAll || f.verdict !== 'pass')
  .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.name.localeCompare(b.name));

console.log(`\nAsset fitness — ${findings.length} path piece(s) of ${models.length} models\n`);
for (const f of shown) {
  const dims = f.size ? `${f.size[0]} x ${f.size[2]} m` : 'unmeasured';
  console.log(`${ICON[f.verdict]} ${f.name}  [${f.kit ?? 'no kit'}]  ${dims}  lane ${f.lane ?? '?'}`);
  for (const r of f.reasons) console.log(`    - ${r}`);
}

const counts = findings.reduce((acc, f) => ({ ...acc, [f.verdict]: (acc[f.verdict] ?? 0) + 1 }), {});
console.log(
  `\n${counts.pass ?? 0} pass · ${counts['needs-eyes'] ?? 0} need eyes · ${counts.fail ?? 0} fail`,
);
if (!showAll && shown.length < findings.length) {
  console.log(`(${findings.length - shown.length} clean pass(es) hidden — re-run with --all)`);
}

if (process.argv.includes('--strict') && (counts.fail ?? 0) > 0) process.exit(1);
