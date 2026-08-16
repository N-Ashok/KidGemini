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
const failures = [];
const refusals = [];
for (const p of selected) {
  process.stdout.write(`  generating ${p.id} … `);
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: p.text, history: [] }),
  }).catch((e) => {
    throw new Error(`could not reach ${BASE} — is \`npm run dev\` running? (${e.message})`);
  });
  if (!res.ok) {
    // NEVER abort the whole run on one prompt (2026-08-16). The first real run
    // of the expanded 13-prompt set died on prompt 5 with a guest `ip_limit`
    // 401 — and took the four games it had ALREADY generated down with it,
    // unverified. Model calls cost money; throwing away work that is already
    // paid for is the one thing this harness must not do. Record the failure,
    // keep going, and verify whatever was produced.
    failures.push({ id: p.id, why: `${res.status} ${(await res.text()).slice(0, 200)}` });
    console.log(`FAILED — ${res.status}`);
    continue;
  }
  // /api/chat streams NDJSON ({"type":"delta"} … {"type":"done"}), it does not
  // return one JSON object — res.json() threw on the very first delta, so this
  // harness had never actually completed a run (fixed 2026-08-09, while using
  // it to verify the category-map hybrid). Reassemble the stream the way the
  // browser client does: accumulate deltas, prefer whatever final frame
  // carries the artifact.
  const raw = await res.text();
  let streamed = '';
  let body = {};
  let done = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let frame;
    try { frame = JSON.parse(trimmed); } catch { continue; }
    if (typeof frame.text === 'string' && frame.type === 'delta') streamed += frame.text;
    if (frame.type === 'done') done = frame;
    if (frame.artifactHtml || frame.html) body = frame;
  }
  // JUDGE WHAT IS DELIVERED, NOT WHAT WAS STREAMED (2026-08-16). The route
  // can REFUSE a finished game — an unknown three import, a CDN module
  // specifier, a syntax error: all fatal, all unparseable in a browser, so it
  // sends `done` with artifactHtml:null and a "try again" line instead
  // (BUG-FIX-LOG 2026-08-15). The model's fenced HTML is still sitting in the
  // stream, and an earlier version of this harness fished it out and saved it
  // — so the runs on disk were files NO CHILD WOULD EVER SEE, and the harness
  // reported a defect the pipeline had already handled correctly. A golden run
  // must measure the product, not the model.
  const refused = done !== null && !done.artifactHtml && !done.html;
  const fenced = streamed.match(/```html\s*([\s\S]*?)(?:```|$)/i)?.[1];
  const html = refused
    ? ''
    : (body.artifactHtml ?? body.html ?? fenced ?? (/<!doctype html|<html/i.test(streamed) ? streamed : ''));
  if (!html) {
    if (refused) {
      // Not a harness failure and not a silent pass: the pipeline caught a
      // fatal game and served a retry line instead. Correct behaviour — and
      // still a bad turn for the child, so it is counted and reported.
      console.log('REFUSED BY THE PIPELINE (correct — a fatal game was not served)');
      console.log(`    the child would see: ${(done.text ?? '').slice(0, 120)}`);
      refusals.push({ id: p.id, shown: (done.text ?? '').slice(0, 120) });
    } else {
      console.log('NO GAME RETURNED');
      console.log(`    the model replied without an artifact: ${(body.text ?? '').slice(0, 160)}`);
    }
    continue;
  }
  const file = join(runsDir, `${p.id}.html`);
  writeFileSync(file, html);
  files.push(file);
  const prior = ledger[p.id];
  console.log(`${html.length} bytes${prior ? ` (last accepted: ${prior.bytes} bytes, ${prior.acceptedAt.slice(0, 10)})` : ' (never accepted)'}`);
}

if (refusals.length) {
  console.log(`\n⚠ ${refusals.length} of ${selected.length} prompt(s) produced a game the pipeline REFUSED to serve.`);
  console.log('  The lints did their job — nothing broken reached a child — but the child got a');
  console.log('  "try again" line instead of a game, so these are real bad turns:');
  for (const r of refusals) console.log(`    ${r.id}: ${r.shown}`);
}

if (failures.length) {
  console.log(`\n⚠ ${failures.length} of ${selected.length} prompt(s) never generated:`);
  for (const f of failures) console.log(`    ${f.id}: ${f.why}`);
  console.log('  A guest 401/ip_limit means the harness ran out of free asks — sign in or');
  console.log('  raise the local guest allowance; the games below are still worth checking.');
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
// A partial run is not a pass. Exit non-zero so an unattended invocation cannot
// be read as "all 13 golden prompts are clean" when only four of them ran.
if (failures.length || refusals.length) process.exit(2);
