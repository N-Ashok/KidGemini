// Which published models can actually MOVE? (2026-08-20)
//
// WHY THIS EXISTS. The owner's report was "the animals ... didnot move. they
// are kiddish." Nothing in the repo could answer that: the manifest records
// bytes, licence and size, but not whether a model carries an animation rig —
// so "make the elephant walk" failing was indistinguishable from a prompt bug.
// It is not a prompt bug. A GLB's first chunk is JSON, and `animations[]` is
// right there in it, so the answer is a range-fetch away.
//
// Cheap by construction: fetches only the first 256 KB of each file and parses
// the JSON chunk. No browser, no full download, no model call.
//
//   node scripts/model-animation-census.mjs              # summary + statics
//   node scripts/model-animation-census.mjs --json out.json
//   node scripts/model-animation-census.mjs --all        # every model, with clips
//
// A STATIC MODEL IS NOT AUTOMATICALLY A BUG — a tree, a crate or a road tile
// should not move. Read the static list with judgement: it is creatures and
// characters appearing there that matter.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repo, "src/lib/assets/manifest.json"), "utf8"));
const models = manifest.assets.filter((a) => a.type === "model");

const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf("--json");
const showAll = argv.includes("--all");
const HEAD_BYTES = 262_143;

async function inspect(a) {
  try {
    const r = await fetch(a.url, { headers: { Range: `bytes=0-${HEAD_BYTES}` } });
    if (!r.ok && r.status !== 206) return { name: a.name, err: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 20 || buf.toString("utf8", 0, 4) !== "glTF") return { name: a.name, err: "not a GLB" };
    const jsonLen = buf.readUInt32LE(12);
    // Fail loudly rather than reporting "no animations" for a file whose JSON
    // chunk simply did not fit — a false "static" here would get a good model
    // deleted.
    if (12 + 8 + jsonLen > buf.length) return { name: a.name, err: `JSON chunk ${jsonLen}B exceeds fetched head` };
    const g = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
    return {
      name: a.name,
      bytes: a.bytes,
      license: a.license,
      sourceUrl: a.sourceUrl,
      clips: (g.animations ?? []).map((x) => x.name ?? "(unnamed)"),
      skins: (g.skins ?? []).length,
    };
  } catch (e) {
    return { name: a.name, err: e.message };
  }
}

const out = [];
const CONC = 12;
for (let i = 0; i < models.length; i += CONC) {
  out.push(...(await Promise.all(models.slice(i, i + CONC).map(inspect))));
  process.stderr.write(`\r  inspecting ${out.length}/${models.length}`);
}
process.stderr.write("\r".padEnd(40) + "\r");

const errs = out.filter((o) => o.err);
const moving = out.filter((o) => !o.err && o.clips.length);
const static_ = out.filter((o) => !o.err && !o.clips.length);

if (showAll) {
  for (const o of out.sort((a, b) => a.name.localeCompare(b.name))) {
    if (o.err) { console.log(`  ERR    ${o.name.padEnd(22)} ${o.err}`); continue; }
    const clips = o.clips.map((c) => c.split("|").pop()).slice(0, 6).join(", ");
    console.log(`  ${o.clips.length ? "MOVES " : "STATIC"} ${o.name.padEnd(22)} ${String(o.bytes).padStart(7)}B  ${clips}`);
  }
} else {
  console.log("\nStatic models (no animation clips):\n");
  console.log("  " + static_.map((o) => o.name).sort().join("  ").replace(/(.{110}\s)/g, "$1\n  "));
}

console.log(`\n${out.length} models · ${moving.length} animated · ${static_.length} static · ${errs.length} unreadable`);
for (const e of errs) console.log(`  ! ${e.name}: ${e.err}`);

if (jsonIdx >= 0) {
  writeFileSync(argv[jsonIdx + 1], JSON.stringify(out, null, 1));
  console.log(`\nwrote ${argv[jsonIdx + 1]}`);
}
