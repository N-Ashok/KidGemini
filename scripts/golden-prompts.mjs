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


// ── Two-turn mode (2026-08-17, KNOWN_BUGS #19) ──────────────────────────────
//
// This harness could only ever express ONE turn, and every fault found on
// 2026-08-17 was introduced by an EDIT: the aeroplane silently swapped for a
// spaceship, the added cars that never appeared, the buttons an overlay ate,
// the buildings replaced by hand-built boxes. An edit also gets a DIFFERENT
// (slimmed) contract from a build, so a rule pinned only on the build path
// looks correct and does nothing — which is exactly what happened to the
// pointer-events rule before its edit-turn test caught it.
//
// The model-name diff is the part that turns a judgement into a NUMBER. A
// child cannot be asked "did the plane stay a plane?"; comparing which models
// the code LOADS before and after can be.

// Mirrors LOAD_MODEL_RE + the placeModel shape in src/lib/assets/model-swap-lint.ts
// and src/lib/assets/model-select.ts. Duplicated deliberately: this is an
// on-demand .mjs dev tool that cannot import the TypeScript source. Reads CALL
// SITES, never the marker or AR_ASSETS — injection reclaims old names, so a
// swapped-out model's URL survives in the table even though no code loads it.
const LOADED_MODEL_RE = /\b(?:loadModel|loadModelBatch|placeModel)\s*\(\s*['"`]([a-z0-9_]+)['"`]/gi;

function loadedModelNames(html) {
  const names = new Set();
  for (const m of html.matchAll(LOADED_MODEL_RE)) names.add(m[1].toLowerCase());
  return names;
}

/** Words a child could plausibly have used for a model name. */
function mentions(message, name) {
  const words = [name, name.replace(/_/g, ' '), name.split('_').pop()];
  return words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(message));
}

/** One real turn against the running app. Returns {html, refused, text}. */
async function turn({ message, history }) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, history }),
  }).catch((e) => {
    throw new Error(`could not reach ${BASE} — is \`npm run dev\` running? (${e.message})`);
  });
  if (!res.ok) return { html: '', refused: false, status: res.status, text: (await res.text()).slice(0, 200) };

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
  const refused = done !== null && !done.artifactHtml && !done.html;
  const fenced = streamed.match(/```html\s*([\s\S]*?)(?:```|$)/i)?.[1];
  const html = refused
    ? ''
    : (body.artifactHtml ?? body.html ?? fenced ?? (/<!doctype html|<html/i.test(streamed) ? streamed : ''));
  return { html, refused, status: 200, text: done?.text ?? body.text ?? '' };
}

mkdirSync(runsDir, { recursive: true });

const files = [];
const failures = [];
const refusals = [];
const editFaults = [];
for (const p of selected) {
  process.stdout.write(`  generating ${p.id} … `);
  // Same one-turn helper the edit below uses — the NDJSON reassembly and the
  // "judge what is DELIVERED, not what was streamed" rule live in one place
  // now, so the build and edit paths cannot drift apart.
  const built = await turn({ message: p.text, history: [] });
  if (built.status !== 200) {
    // NEVER abort the whole run on one prompt (2026-08-16). The first real run
    // of the expanded 13-prompt set died on prompt 5 with a guest `ip_limit`
    // 401 — and took the four games it had ALREADY generated down with it,
    // unverified. Model calls cost money; throwing away work that is already
    // paid for is the one thing this harness must not do.
    failures.push({ id: p.id, why: `${built.status} ${built.text}` });
    console.log(`FAILED — ${built.status}`);
    continue;
  }
  const html = built.html;
  if (!html) {
    if (built.refused) {
      // Not a harness failure and not a silent pass: the pipeline caught a
      // fatal game and served a retry line instead. Correct behaviour — and
      // still a bad turn for the child, so it is counted and reported.
      console.log('REFUSED BY THE PIPELINE (correct — a fatal game was not served)');
      console.log(`    the child would see: ${built.text.slice(0, 120)}`);
      refusals.push({ id: p.id, shown: built.text.slice(0, 120) });
    } else {
      console.log('NO GAME RETURNED');
      console.log(`    the model replied without an artifact: ${built.text.slice(0, 160)}`);
    }
    continue;
  }
  const file = join(runsDir, `${p.id}.html`);
  writeFileSync(file, html);
  files.push(file);
  const prior = ledger[p.id];
  console.log(`${html.length} bytes${prior ? ` (last accepted: ${prior.bytes} bytes, ${prior.acceptedAt.slice(0, 10)})` : ' (never accepted)'}`);

  // ── the SECOND turn, where the faults actually enter ─────────────────────
  if (!p.edit) continue;
  process.stdout.write(`  editing   ${p.id} … `);
  const edited = await turn({
    message: p.edit.text,
    history: [
      { role: 'child', text: p.text },
      { role: 'assistant', text: 'Here is your game!', artifactHtml: html },
    ],
  });
  if (edited.status !== 200) {
    failures.push({ id: `${p.id}:edit`, why: `${edited.status} ${edited.text}` });
    console.log(`FAILED — ${edited.status}`);
    continue;
  }
  if (!edited.html) {
    if (edited.refused) {
      console.log('REFUSED BY THE PIPELINE (correct — a fatal edit was not served)');
      refusals.push({ id: `${p.id}:edit`, shown: edited.text.slice(0, 120) });
    } else {
      // A soft-fail: the patch never applied and the game was left untouched.
      // Not a crash, and still a turn where the child asked for something and
      // got nothing — which is precisely the failure the owner kept hitting.
      console.log('NO GAME RETURNED — the edit was lost (soft-fail)');
      editFaults.push({ id: p.id, why: 'the edit produced no game — the child\'s ask did nothing' });
    }
    continue;
  }
  const editFile = join(runsDir, `${p.id}.edit.html`);
  writeFileSync(editFile, edited.html);
  files.push(editFile);

  // THE MEASUREMENT: which models did the game stop loading, and did the child
  // ask for that? An unrequested swap is now a number, not a judgement.
  const before = loadedModelNames(html);
  const after = loadedModelNames(edited.html);
  const dropped = [...before].filter((n) => !after.has(n));
  const added = [...after].filter((n) => !before.has(n));
  const unrequested = dropped.filter((n) => !mentions(p.edit.text, n));
  console.log(`${edited.html.length} bytes · models ${before.size}→${after.size}` +
    `${added.length ? ` +${added.join(',')}` : ''}${dropped.length ? ` -${dropped.join(',')}` : ''}`);
  if (unrequested.length) {
    console.log(`    ✖ UNREQUESTED MODEL SWAP: ${unrequested.join(', ')} — the child never mentioned these`);
    editFaults.push({ id: p.id, why: `dropped ${unrequested.join(', ')} without being asked` });
  }
  // An edit that ADDS a thing the child named must actually load a model for
  // it — the "add lots of cars and bikes" case, silent for as long as the
  // loadModelBatch healing gap existed.
  if (/\badd\b/i.test(p.edit.text) && added.length === 0 && dropped.length === 0) {
    console.log('    ⚠ the edit added NO new model — check the child got what they asked for');
    editFaults.push({ id: p.id, why: 'an "add" edit introduced no new model at all' });
  }
}

if (refusals.length) {
  console.log(`\n⚠ ${refusals.length} of ${selected.length} prompt(s) produced a game the pipeline REFUSED to serve.`);
  console.log('  The lints did their job — nothing broken reached a child — but the child got a');
  console.log('  "try again" line instead of a game, so these are real bad turns:');
  for (const r of refusals) console.log(`    ${r.id}: ${r.shown}`);
}

if (editFaults.length) {
  console.log(`\n✖ ${editFaults.length} EDIT turn(s) went wrong. Edits get the slimmed edit contract,`);
  console.log('  and every fault found on 2026-08-17 entered on an edit rather than a build:');
  for (const e of editFaults) console.log(`    ${e.id}: ${e.why}`);
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
// playwright-core lives in the SIBLING platform repo, not here (2026-08-17).
// Without this the verifier cannot start, and the run then reported
// "✖ At least one golden game does not RUN" — which is FALSE, and is the
// worst thing a safety net can say. A tool that cries wolf about the
// environment teaches its reader to discount it when it reports a real fault;
// curated-imports.test.ts makes exactly this argument about false alarms.
// So: point it at the sibling install if it is not resolvable here, and keep
// "the verifier could not start" strictly distinct from "a game is broken".
const verifyEnv = { ...process.env };
if (!verifyEnv.PLAYWRIGHT_CORE_DIR) {
  const sibling = join(repo, '../Ariantra-Platform/node_modules/playwright-core');
  if (existsSync(sibling)) verifyEnv.PLAYWRIGHT_CORE_DIR = sibling;
}
try {
  execFileSync('node', [join(repo, 'scripts/verify-game-html.mjs'), ...files], {
    stdio: 'inherit',
    cwd: repo,
    env: verifyEnv,
  });
} catch (err) {
  // status === null means the process could not be spawned or died on a
  // signal; a non-zero status is the verifier's own verdict on the games.
  const brokenGames = typeof err.status === 'number' && err.status !== 0;
  if (brokenGames) {
    console.error('\n✖ At least one golden game does not RUN. That is a hard failure — it is the');
    console.error('  class of fault every string-assertion test in this repo is blind to.');
  } else {
    console.error('\n⚠ The browser verifier could not START, so the games above are UNVERIFIED.');
    console.error('  This is an environment problem, not a verdict on the games — do not read');
    console.error('  it as a pass OR as a failure. Most likely playwright-core is missing:');
    console.error('    PLAYWRIGHT_CORE_DIR=../Ariantra-Platform/node_modules/playwright-core \\');
    console.error('      node scripts/verify-game-html.mjs golden/runs/*.html');
  }
  process.exit(1);
}

console.log('\nEvery golden game runs clean. Now LOOK at them — mechanical checks cannot see');
console.log('a track whose corners do not meet:');
for (const f of files) console.log(`  open ${f}`);
console.log('\nHappy with one? Record it:  node scripts/golden-prompts.mjs --accept <id>');
// An unrequested model swap or a lost edit is a MECHANICAL fault, not a matter
// of taste — it fails the run without a human having to notice it.
if (editFaults.length) {
  console.error(`\n✖ ${editFaults.length} edit fault(s) — see above.`);
  process.exit(1);
}
// A partial run is not a pass. Exit non-zero so an unattended invocation cannot
// be read as "all 13 golden prompts are clean" when only four of them ran.
if (failures.length || refusals.length) process.exit(2);
