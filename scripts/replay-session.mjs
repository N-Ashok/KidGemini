// Replay harness — docs/2026-08-25_PRD_EditTurnCost_CachingAndThinking.md §6.
//
// Replays a FIXED child-shaped conversation (golden/sessions/<id>.json) through
// the REAL /api/chat path, turn by turn, feeding each turn's answer back as
// history exactly the way the browser client does, and records what Google
// actually BILLED per turn (prompt / cached / output / thinking tokens and the
// metered $). Two runs with different labels ("before" / "after") give the
// per-turn cost comparison a prompt-shape change must show before it ships.
//
// This exists so the owner's production UAT is never the test loop (global
// rule 12): the number comes from a real model, on the real route, on a
// repeatable session — not from a unit test that asserts on a string.
//
// It touches NO child data: the session file is synthetic, and the harness
// reads usage from the `done` frame (the route exposes it only when the dev
// server runs with EXPOSE_TURN_USAGE=1 — never in production).
//
// ON DEMAND ONLY, never in CI: each run costs real model calls.
//
// Prereqs: `EXPOSE_TURN_USAGE=1 npm run dev` on :3000 with real credentials.
//
//   node scripts/replay-session.mjs physics-world --label before
//   node scripts/replay-session.mjs physics-world --label after
//   node scripts/replay-session.mjs physics-world --label after --skip-pause   # ignore pauseMs (fast, no TTL read)
//   node scripts/replay-session.mjs --compare before after                    # print the table
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const sessionsDir = join(repo, 'golden', 'sessions');
const runsDir = join(repo, 'golden', 'runs', 'sessions');
const BASE = process.env.GOLDEN_BASE ?? 'http://localhost:3000';
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);

function usd(n) { return `$${n.toFixed(4)}`; }
function pct(a, b) { return b ? `${Math.round((a / b) * 100)}%` : '—'; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function summarize(run) {
  const t = run.turns.filter((x) => x.usage);
  const sum = (k) => t.reduce((a, x) => a + (x.usage[k] ?? 0), 0);
  return {
    turns: t.length,
    promptTokens: sum('promptTokens'), cachedTokens: sum('cachedTokens'),
    outputTokens: sum('outputTokens'), thoughtTokens: sum('thoughtTokens'), costUsd: sum('costUsd'),
    editTurns: t.filter((x) => x.kind === 'edit').length,
    editCostUsd: t.filter((x) => x.kind === 'edit').reduce((a, x) => a + x.usage.costUsd, 0),
    editThought: t.filter((x) => x.kind === 'edit').reduce((a, x) => a + (x.usage.thoughtTokens ?? 0), 0),
    patchOk: t.filter((x) => x.kind === 'edit' && x.outcome === 'patched').length,
  };
}

function printRun(run) {
  console.log(`\n${run.session} · ${run.label} · ${run.at}`);
  console.log(pad('turn', 18) + pad('model', 22) + pad('kind', 7) + pad('outcome', 10) + pad('prompt', 8) + pad('cached', 8) + pad('out', 7) + pad('think', 7) + pad('$', 9) + 'ms');
  for (const t of run.turns) {
    const u = t.usage ?? {};
    console.log(pad(t.id, 18) + pad(u.model ?? '—', 22) + pad(t.kind, 7) + pad(t.outcome, 10) + pad(u.promptTokens ?? '—', 8) + pad(u.cachedTokens ?? '—', 8) + pad(u.outputTokens ?? '—', 7) + pad(u.thoughtTokens ?? '—', 7) + pad(u.costUsd !== undefined ? usd(u.costUsd) : '—', 9) + t.ms);
  }
  const s = summarize(run);
  console.log(`total ${usd(s.costUsd)} over ${s.turns} billed turns · cached ${pct(s.cachedTokens, s.promptTokens)} of prompt · edit turns ${s.editTurns}: ${usd(s.editCostUsd)} (${s.editTurns ? usd(s.editCostUsd / s.editTurns) : '—'}/edit, think avg ${s.editTurns ? Math.round(s.editThought / s.editTurns) : '—'}), patched ${s.patchOk}/${s.editTurns}`);
}

if (has('--compare')) {
  const i = argv.indexOf('--compare');
  const [a, b] = [argv[i + 1], argv[i + 2]];
  const id = argv.find((x) => !x.startsWith('--') && x !== a && x !== b) ?? 'physics-world';
  const load = (l) => JSON.parse(readFileSync(join(runsDir, `${id}.${l}.json`), 'utf8'));
  const [ra, rb] = [load(a), load(b)];
  printRun(ra); printRun(rb);
  const [sa, sb] = [summarize(ra), summarize(rb)];
  const d = (x, y) => (x ? `${Math.round(((y - x) / x) * 100)}%` : '—');
  console.log(`\n${a} → ${b}: session ${usd(sa.costUsd)} → ${usd(sb.costUsd)} (${d(sa.costUsd, sb.costUsd)}) · per edit ${usd(sa.editCostUsd / (sa.editTurns || 1))} → ${usd(sb.editCostUsd / (sb.editTurns || 1))} (${d(sa.editCostUsd / (sa.editTurns || 1), sb.editCostUsd / (sb.editTurns || 1))}) · cached ${pct(sa.cachedTokens, sa.promptTokens)} → ${pct(sb.cachedTokens, sb.promptTokens)} · edit think avg ${Math.round(sa.editThought / (sa.editTurns || 1))} → ${Math.round(sb.editThought / (sb.editTurns || 1))} · patched ${sa.patchOk}/${sa.editTurns} → ${sb.patchOk}/${sb.editTurns}`);
  process.exit(0);
}

const sessionId = argv.find((x) => !x.startsWith('--') && x !== flag('--label')) ?? 'physics-world';
const label = flag('--label') ?? 'run';
const session = JSON.parse(readFileSync(join(sessionsDir, `${sessionId}.json`), 'utf8'));
mkdirSync(runsDir, { recursive: true });

const history = [];
const idByTurn = new Map();
// Local dev only: the guest gate caps tokens per IP (gate.config IP_GUEST_TOKEN_CAP)
// and this harness is a fresh guest every turn, so one run can exhaust the
// cap for ::1. Present a synthetic per-run client IP (geo.ts honours
// x-forwarded-for) — meaningless against a real deployment behind Caddy,
// which overwrites the header.
const fakeIp = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const run = { session: sessionId, label, at: new Date().toISOString(), base: BASE, turns: [] };
let seq = 0;
const msg = (role, text, extra = {}) => ({ id: `r${++seq}`, role, text, createdAt: Date.now(), ...extra });

console.log(`replaying ${sessionId} (${session.turns.length} turns) as "${label}" against ${BASE}`);
for (const turn of session.turns) {
  if (turn.pauseMs && !has('--skip-pause')) {
    process.stdout.write(`  pausing ${Math.round(turn.pauseMs / 1000)}s (TTL read) … `);
    await new Promise((r) => setTimeout(r, turn.pauseMs));
    console.log('ok');
  }
  const hasGame = history.some((m) => m.artifactHtml);
  const activeGameMessageId = turn.pinTo ? idByTurn.get(turn.pinTo) : undefined;
  if (turn.pinTo && !activeGameMessageId) throw new Error(`${turn.id}: pinTo "${turn.pinTo}" has no game to pin`);
  process.stdout.write(`  ${turn.id} … `);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': fakeIp },
    body: JSON.stringify({ message: turn.text, history, ...(activeGameMessageId ? { activeGameMessageId } : {}) }),
  }).catch((e) => { throw new Error(`could not reach ${BASE} — is \`EXPOSE_TURN_USAGE=1 npm run dev\` running? (${e.message})`); });
  if (!res.ok) throw new Error(`${turn.id}: /api/chat returned ${res.status} ${await res.text()}`);
  const raw = await res.text();
  let done = null;
  for (const line of raw.split('\n')) {
    const s = line.trim(); if (!s) continue;
    let f; try { f = JSON.parse(s); } catch { continue; }
    if (f.type === 'done') done = f;
  }
  const ms = Date.now() - t0;
  if (!done) { console.log('NO DONE FRAME'); run.turns.push({ id: turn.id, kind: hasGame ? 'edit' : 'build', outcome: 'no-done', ms }); continue; }
  if (!done.usage) throw new Error(`${turn.id}: done frame has no usage — start the dev server with EXPOSE_TURN_USAGE=1`);
  const outcome = done.artifactHtml ? (hasGame ? 'patched' : 'built') : (done.newGamePrompt ? 'new-game?' : 'no-game');
  const kind = hasGame ? 'edit' : 'build';
  run.turns.push({ id: turn.id, kind, outcome, ms, usage: done.usage, textHead: String(done.text ?? '').slice(0, 80), artifactBytes: done.artifactHtml ? done.artifactHtml.length : 0 });
  console.log(`${outcome} · ${done.usage.model} · prompt ${done.usage.promptTokens} (cached ${done.usage.cachedTokens}) out ${done.usage.outputTokens} think ${done.usage.thoughtTokens} · ${usd(done.usage.costUsd)} · ${ms}ms`);
  // Feed back exactly what the browser would: the child's line, then the
  // assistant's prose with the (new or kept) game on the message.
  history.push(msg('child', turn.text));
  const assistant = msg('assistant', done.text ?? '', done.artifactHtml ? { artifactHtml: done.artifactHtml } : {});
  history.push(assistant);
  if (done.artifactHtml) idByTurn.set(turn.id, assistant.id);
  if (done.artifactHtml) writeFileSync(join(runsDir, `${sessionId}.${label}.${turn.id}.html`), done.artifactHtml);
}
writeFileSync(join(runsDir, `${sessionId}.${label}.json`), JSON.stringify(run, null, 2) + '\n');
printRun(run);
console.log(`\nsaved golden/runs/sessions/${sessionId}.${label}.json — compare with: node scripts/replay-session.mjs ${sessionId} --compare before after`);
