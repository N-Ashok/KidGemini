// Thinking-budget probe — docs/2026-08-25_PRD_EditTurnCost_CachingAndThinking.md §4.B.1.
//
// Prod metering shows 3.6/3.7-flash spending 2–4× the configured
// GEMINI_BUILDER_THINKING_BUDGET (1,024) on edit turns. Three hypotheses, one
// probe: send ONE realistic edit prompt (a real game source + a small ask) with
// several thinking configs and read `usageMetadata.thoughtsTokenCount` back.
//
//   H2  the 3.x line wants `thinkingLevel` and ignores `thinkingBudget`
//   H3  `thinkingBudget` is honoured but soft (constant overshoot ratio)
//   (H1 — box .env overrides the budget — is the owner's to check, not this script's)
//
// ON DEMAND, real model calls (~$0.3–0.5 a run). Never in CI.
//
//   node --env-file=.env.local scripts/probe-thinking.mjs
//   node --env-file=.env.local scripts/probe-thinking.mjs gemini-3.7-flash   # one model
import { GoogleGenAI } from '@google/genai';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const backend = (env.GEMINI_BACKEND ?? 'studio').trim().toLowerCase();
const opts = backend === 'vertex' ? { vertexai: true, apiKey: env.VERTEX_API_KEY } : { apiKey: env.GEMINI_API_KEY };
if (!opts.apiKey) { console.error('no API key in env (GEMINI_API_KEY / VERTEX_API_KEY) — run with node --env-file=.env.local'); process.exit(1); }
const ai = new GoogleGenAI(opts);

const models = process.argv[2] ? [process.argv[2]] : [env.GEMINI_CHAT_MODEL ?? 'gemini-3.6-flash', 'gemini-3.7-flash'];

// A real game as the edit source, if a golden run exists; else a small stand-in.
const runsDir = join(repo, 'golden', 'runs');
const golden = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => f.endsWith('.html')).map((f) => join(runsDir, f)) : [];
const source = golden.length ? readFileSync(golden[0], 'utf8') : `<!doctype html><html><head><title>Bounce</title></head><body><canvas id="c"></canvas><script>
// --- SETUP ---
const c=document.getElementById('c'),x=c.getContext('2d');c.width=480;c.height=320;
// --- BALL ---
let b={x:240,y:40,vx:2,vy:0,r:12},g=0.3,bounce=0.7,score=0;
// --- LOOP ---
function loop(){b.vy+=g;b.x+=b.vx;b.y+=b.vy;if(b.y+b.r>c.height){b.y=c.height-b.r;b.vy*=-bounce;score++}if(b.x<b.r||b.x>c.width-b.r)b.vx*=-1;
x.clearRect(0,0,c.width,c.height);x.beginPath();x.arc(b.x,b.y,b.r,0,7);x.fill();x.fillText('Score '+score,10,20);requestAnimationFrame(loop)}loop();
</script></body></html>`;
console.log(`source: ${golden.length ? golden[0] : 'built-in stand-in'} (${source.length} chars)`);

const system = `You are helping a child edit their game. Return the change as one or more SEARCH/REPLACE blocks:
<<<<<<< SEARCH
(lines copied exactly from the current source)
=======
(replacement)
>>>>>>> REPLACE
Change only what the request needs. No full document, no prose after the blocks.`;
const ask = 'make the ball bounce higher and show the score in the top right corner';
const contents = [{ role: 'user', parts: [{ text: `Current game source:\n\`\`\`html\n${source}\n\`\`\`\n\nThe child asked: ${ask}` }] }];

const configs = [
  { name: 'budget 256', thinkingConfig: { thinkingBudget: 256, includeThoughts: true } },
  { name: 'budget 512', thinkingConfig: { thinkingBudget: 512, includeThoughts: true } },
  { name: 'budget 1024', thinkingConfig: { thinkingBudget: 1024, includeThoughts: true } },
  { name: 'budget 1024 no-summaries', thinkingConfig: { thinkingBudget: 1024 } },
  { name: 'level LOW', thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: true } },
  { name: 'budget 0 (off)', thinkingConfig: { thinkingBudget: 0 } },
  { name: 'budget -1 (dynamic)', thinkingConfig: { thinkingBudget: -1 } },
  { name: 'no thinkingConfig', thinkingConfig: undefined },
];
const REPEATS = Number(env.PROBE_REPEATS ?? 3);
// Prod streams (generateContentStream) and bills off the LAST usageMetadata
// seen — do the same, so the number here is the number the meter records.
async function call(model, cfg) {
  const stream = await ai.models.generateContentStream({
    model, contents,
    config: { systemInstruction: system, maxOutputTokens: 4096, ...(cfg.thinkingConfig ? { thinkingConfig: cfg.thinkingConfig } : {}) },
  });
  let usage = {}; let text = '';
  for await (const chunk of stream) {
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) if (part.text && !part.thought) text += part.text;
  }
  return { usageMetadata: usage, text };
}

const rows = [];
for (const model of models) {
  for (const cfg of configs) {
    for (let i = 0; i < REPEATS; i++) {
      process.stdout.write(`  ${model} · ${cfg.name} #${i + 1} … `);
      const t0 = Date.now();
      try {
        const res = await call(model, cfg);
        const u = res.usageMetadata ?? {};
        const patched = /<{7} SEARCH/.test(res.text);
        const row = { model, config: cfg.name, rep: i + 1, thoughts: u.thoughtsTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, prompt: u.promptTokenCount ?? 0, patchShaped: patched, ms: Date.now() - t0 };
        rows.push(row);
        console.log(`thoughts ${row.thoughts} · out ${row.output} · ${patched ? 'patch ✓' : 'NO PATCH'} · ${row.ms}ms`);
      } catch (e) {
        const m = String(e.message ?? e).slice(0, 140);
        rows.push({ model, config: cfg.name, rep: i + 1, error: m });
        console.log(`ERROR ${m}`);
        break;
      }
    }
  }
}
console.log();
console.table(rows);
const agg = {};
for (const r of rows.filter((r) => !r.error)) { const k = r.model + ' | ' + r.config; (agg[k] ??= { model: r.model, config: r.config, n: 0, thoughts: 0, output: 0, ms: 0, patch: 0 }); const a = agg[k]; a.n++; a.thoughts += r.thoughts; a.output += r.output; a.ms += r.ms; a.patch += r.patchShaped ? 1 : 0; }
console.table(Object.values(agg).map((a) => ({ model: a.model, config: a.config, n: a.n, avgThoughts: Math.round(a.thoughts / a.n), avgOutput: Math.round(a.output / a.n), avgMs: Math.round(a.ms / a.n), patchOk: `${a.patch}/${a.n}` })));
console.log('\nReading: if "level *" rows differ sharply while "budget *" rows are flat → H2 (budget ignored, level honoured). If budget rows scale with the number but overshoot by a steady ratio → H3. Paste this table into the PRD §10.');
