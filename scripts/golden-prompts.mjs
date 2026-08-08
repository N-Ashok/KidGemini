// Layer 2 — golden prompts (docs/2026-08-08_PRD_AssetFitnessAndReview.md §4).
//
// Runs a FIXED, SMALL set of child-shaped prompts through the REAL generation
// path and then through scripts/verify-game-html.mjs, which loads each result
// in a browser. This is the only check in the repo that can catch a fault where
// every asset is individually fine and the SYSTEM OUTPUT is wrong — the shape
// of both race-track bugs, and of the 2026-08-09 production outage that 2,190
// green string-assertions missed.
//
// ON DEMAND ONLY, never per-asset and never in CI: each run costs real model
// calls. That cost is exactly why it must not be wired into the asset gate —
// a 30-asset batch that triggers 30 generations is a tool nobody runs twice.
//
// NOT AN AUTOMATIC PASS/FAIL on content. No assertion can express "the road
// looks right", and one that tried would demand SAMENESS — which would make
// every child's game converge, the opposite of the point. It checks the
// MECHANICAL facts (does it run, do assets resolve, is a canvas drawn) and
// leaves the picture to a human. Verdicts are recorded next to each run.
//
// Prereqs: `npm run dev` on :3000 with real model credentials.
//
//   node scripts/golden-prompts.mjs                 # run all, verify, report
//   node scripts/golden-prompts.mjs race-track      # just one
//   node scripts/golden-prompts.mjs --accept race-track   # mark last run good

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const goldenDir = join(repo, 'golden');
const runsDir = join(goldenDir, 'runs');
const { prompts } = JSON.parse(readFileSync(join(goldenDir, 'prompts.json'), 'utf8'));
const ledgerPath = join(goldenDir, 'accepted.json');

const argv = process.argv.slice(2);
const acceptIdx = argv.indexOf('--accept');
const BASE = process.env.GOLDEN_BASE ?? 'http://localhost:3000';
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {};

if (acceptIdx >= 0) {
  const id = argv[acceptIdx + 1];
  const file = join(runsDir, `${id}.html`);
  if (!existsSync(file)) throw new Error(`no run to accept for "${id}" — run it first`);
  // Records WHO accepted it and WHEN. The value of a golden run is entirely in
  // a human having looked at it; an unattributed "accepted" is worth nothing.
  ledger[id] = { acceptedAt: new Date().toISOString(), bytes: readFileSync(file, 'utf8').length };
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  console.log(`✓ accepted ${id} — this is now the reference a future run is compared against`);
  process.exit(0);
}

const only = argv.filter((a) => !a.startsWith('--'));
const selected = only.length ? prompts.filter((p) => only.includes(p.id)) : prompts;
if (!selected.length) throw new Error(`no prompt matched ${only.join(', ')} — see golden/prompts.json`);

mkdirSync(runsDir, { recursive: true });

const files = [];
for (const p of selected) {
  process.stdout.write(`  generating ${p.id} … `);
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: p.text, history: [] }),
  }).catch((e) => {
    throw new Error(`could not reach ${BASE} — is \`npm run dev\` running? (${e.message})`);
  });
  if (!res.ok) throw new Error(`${p.id}: /api/chat returned ${res.status} ${await res.text()}`);
  const body = await res.json();
  const html = body.artifactHtml ?? body.html ?? '';
  if (!html) {
    console.log('NO GAME RETURNED');
    console.log(`    the model replied without an artifact: ${(body.text ?? '').slice(0, 160)}`);
    continue;
  }
  const file = join(runsDir, `${p.id}.html`);
  writeFileSync(file, html);
  files.push(file);
  const prior = ledger[p.id];
  console.log(`${html.length} bytes${prior ? ` (last accepted: ${prior.bytes} bytes, ${prior.acceptedAt.slice(0, 10)})` : ' (never accepted)'}`);
}

if (!files.length) {
  console.error('\n✖ nothing generated — nothing to verify.');
  process.exit(1);
}

console.log('\nVerifying in a real browser …\n');
try {
  execFileSync('node', [join(repo, 'scripts/verify-game-html.mjs'), ...files], { stdio: 'inherit', cwd: repo });
} catch {
  console.error('\n✖ At least one golden game does not RUN. That is a hard failure — it is the');
  console.error('  class of fault every string-assertion test in this repo is blind to.');
  process.exit(1);
}

console.log('\nEvery golden game runs clean. Now LOOK at them — mechanical checks cannot see');
console.log('a track whose corners do not meet:');
for (const f of files) console.log(`  open ${f}`);
console.log('\nHappy with one? Record it:  node scripts/golden-prompts.mjs --accept <id>');
