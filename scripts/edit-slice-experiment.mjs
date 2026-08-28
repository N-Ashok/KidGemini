// Edit-slicing experiment runner (2026-08-27, docs/2026-08-27_EXPERIMENT_EditSlicing.md).
// A = real production edit turns (ask + game-before + after-game + billed usage), pulled
// with owner permission into a scratch file OUTSIDE the repo. B = the same ask on the same
// game through the REAL edit path of a dev server started with EDIT_SLICE=on
// EXPOSE_TURN_USAGE=1. Prints only numbers and landmark titles — never chat text or code.
//   node scripts/edit-slice-experiment.mjs <edits.json> <outDir>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [file, outDir] = process.argv.slice(2);
const BASE = process.env.GOLDEN_BASE ?? "http://localhost:3000";
const turns = JSON.parse(readFileSync(file, "utf8"));
const LANDMARK = /^[ \t]*(?:\/\/[ \t]*-{2,}[ \t]*([^\n]{2,60}?)[ \t]*-{2,}|<!--[ \t]*([^\n-]{2,60}?)[ \t]*-->|\/\*[ \t]*-{2,}[ \t]*([^\n*]{2,60}?)[ \t]*-{2,}[ \t]*\*\/)[ \t]*$/;
function sections(html) {
  const lines = html.split("\n"); const out = []; let cur = { title: "(preamble)", text: [] };
  for (const l of lines) { const m = LANDMARK.exec(l); if (m) { out.push(cur); cur = { title: (m[1] ?? m[2] ?? m[3]).trim(), text: [] }; } cur.text.push(l); }
  out.push(cur); return new Map(out.map((s) => [s.title, s.text.join("\n")]));
}
function changed(before, after) {
  const a = sections(before), b = sections(after); const diff = [];
  for (const [t, txt] of b) if (a.get(t) !== txt) diff.push(t);
  for (const t of a.keys()) if (!b.has(t)) diff.push(t + " (removed)");
  return diff;
}
const fakeIp = () => `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}`;
const RATE = { in: 0.75, out: 3.75, cached: 0.075 };
const cost = (u) => ((u.promptTokens - (u.cachedTokens || 0)) * RATE.in + (u.cachedTokens || 0) * RATE.cached + (u.outputTokens + (u.thoughtTokens || 0)) * RATE.out) / 1e6;
const rows = [];
for (let i = 0; i < turns.length; i++) {
  const t = turns[i];
  const history = [
    { id: `h${i}a`, role: "child", text: "make me a game", createdAt: 1 },
    { id: `h${i}b`, role: "assistant", text: "Here you go!", artifactHtml: t.game, createdAt: 2 },
  ];
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": fakeIp() }, body: JSON.stringify({ message: t.ask, history }) });
  const text = await res.text();
  const frames = text.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const done = frames.find((f) => f.type === "done");
  const B = { status: res.status, ms: Date.now() - t0, applied: Boolean(done?.artifactHtml && done.artifactHtml !== t.game), usage: done?.usage ?? null, paywall: frames.some((f) => f.type === "paywall"), error: frames.some((f) => f.type === "error") };
  if (done?.artifactHtml) writeFileSync(join(outDir, `g-${String(i).padStart(2, "0")}.html`), done.artifactHtml);
  const aSections = changed(t.game, t.after);
  const bSections = B.applied ? changed(t.game, done.artifactHtml) : [];
  const overlap = aSections.filter((s) => bSections.includes(s)).length;
  rows.push({ i, game: t.convo.slice(0, 8), askWords: t.ask.split(/\s+/).length, A: { in: t.A.inTok, out: t.A.outTok + t.A.thk, usd: t.A.costUsd, sections: aSections }, B: { ...B, in: B.usage?.promptTokens ?? null, out: B.usage ? B.usage.outputTokens + (B.usage.thoughtTokens || 0) : null, usd: B.usage ? cost(B.usage) : null, sections: bSections, overlap } });
  const r = rows[rows.length - 1];
  console.log(`#${String(i).padStart(2)} A in=${r.A.in} out=${r.A.out} $${r.A.usd.toFixed(4)} | B in=${r.B.in} out=${r.B.out} $${r.B.usd?.toFixed(4) ?? "-"} applied=${r.B.applied} ${r.B.paywall ? "PAYWALL" : ""}${r.B.error ? "ERROR" : ""} | A touched ${aSections.length} sect, B touched ${bSections.length}, same=${overlap}/${aSections.length} | ${r.B.ms}ms`);
}
const ok = rows.filter((r) => r.B.usage);
const sum = (f) => ok.reduce((s, r) => s + f(r), 0);
console.log("\n== SUMMARY (turns with a billed B) n=" + ok.length + " of " + rows.length);
console.log(`A avg: in=${Math.round(sum((r) => r.A.in) / ok.length)} out=${Math.round(sum((r) => r.A.out) / ok.length)} $/edit=${(sum((r) => r.A.usd) / ok.length).toFixed(4)}`);
console.log(`B avg: in=${Math.round(sum((r) => r.B.in) / ok.length)} out=${Math.round(sum((r) => r.B.out) / ok.length)} $/edit=${(sum((r) => r.B.usd) / ok.length).toFixed(4)}`);
console.log(`saving: input ${Math.round(100 * (1 - sum((r) => r.B.in) / sum((r) => r.A.in)))}%, cost ${Math.round(100 * (1 - sum((r) => r.B.usd) / sum((r) => r.A.usd)))}%`);
console.log(`B applied: ${rows.filter((r) => r.B.applied).length}/${rows.length} (A applied 30/30)`);
console.log(`B touched every section A touched: ${rows.filter((r) => r.B.applied && r.B.overlap === r.A.sections.length).length}/${rows.filter((r) => r.B.applied).length}`);
writeFileSync(join(outDir, "results.json"), JSON.stringify(rows, null, 1));
