// Which published models have SPINNABLE NAMED PARTS? (2026-08-23)
//
// WHY THIS EXISTS. The owner: "i feel the helicopter needs to have skeleton to
// rotate the rotor and similarly the car tyres." The 3D prompt had been telling
// the model, for a year, that they do not:
//
//   "Rigid models have NO named parts: a name search (getObjectByName/traverse)
//    finds nothing and your spin is a silent no-op — the only spinnable parts
//    are ones you add."
//
// That is FALSE for the vehicles it most matters for. `car` ships five named
// nodes — body, wheel-front-left, wheel-front-right, wheel-back-left,
// wheel-back-right — and so do truck and race_kart. No skeleton is needed to
// turn a wheel: a wheel is its own NODE, and node.rotation.x is all it takes.
// A skeleton is for a mesh that DEFORMS (a galloping horse); a wheel is rigid
// and merely rotates, which is a parent/child transform, not skinning.
//
// So the prompt was talking games out of the correct, free solution and into
// bolting on fake primitive wheels. This census is the datum that replaces the
// guess — same discipline as the animation census beside it, and the same
// range-fetch trick: a GLB's first chunk is JSON, and `nodes[].name` is in it.
//
//   node scripts/model-parts-census.mjs            # summary + what has parts
//   node scripts/model-parts-census.mjs --all      # every model
//   node scripts/model-parts-census.mjs --write    # refresh the committed
//                                                  # src/lib/assets/model-parts.json
//
// A MODEL WITH NO NAMED PARTS IS NOT A BUG — a crate, a rock or a tree has
// nothing to spin. What matters is a VEHICLE appearing in the no-parts list:
// that one genuinely needs its own primitive rotor/wheel added in code.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repo, "src/lib/assets/manifest.json"), "utf8"));
const models = manifest.assets.filter((a) => a.type === "model");
const argv = process.argv.slice(2);

/** Node names that are structural noise, not a part a game would ever spin.
 *  Exporter defaults (Blender's "Cube"/"Circle", glTF's "RootNode") and the
 *  <unnamed N> placeholders are dropped: offering "Cube" as a part would send a
 *  game hunting for something meaningless. */
const NOISE = /^(rootnode|scene|root|object_?\d*|cube|circle|sphere|plane|cylinder|mesh|node_?\d*|<unnamed)/i;

/** `<part>_mesh` is the geometry BENEATH a spin wrapper (vendor-models.mjs
 *  spinParts). The wrapper carries the name a game uses and the pivot; the
 *  child is an implementation detail of surviving quantization, and offering
 *  it would hand games a node whose transform the compressor owns. */
const INTERNAL = /_mesh$/i;

/** Which parts are worth CALLING OUT — the ones a game wants to move. Kept
 *  deliberately narrow: a broad match would re-introduce guessing under a new
 *  name, which is what this file exists to end. */
const SPINNABLE = /wheel|tyre|tire|rotor|blade|propeller|prop\b|turbine|fan|track|axle/i;

async function nodeNames(url) {
  const res = await fetch(url, { headers: { range: "bytes=0-262143" } });
  if (!res.ok && res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let off = 12; // glTF-Binary header
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) {
      const end = Math.min(off + 8 + len, buf.length);
      const json = JSON.parse(buf.subarray(off + 8, end).toString("utf8"));
      return (json.nodes ?? []).map((n) => n.name).filter((n) => typeof n === "string");
    }
    off += 8 + len;
  }
  throw new Error("no JSON chunk in the first 256 KB");
}

const out = [];
const errs = [];
const CONCURRENCY = 8;
let cursor = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= models.length) return;
      const a = models[i];
      try {
        const all = await nodeNames(a.url);
        const parts = all.filter((n) => !NOISE.test(n) && !INTERNAL.test(n));
        out.push({ name: a.name, parts, spinnable: parts.filter((n) => SPINNABLE.test(n)) });
      } catch (e) {
        errs.push({ name: a.name, error: e.message });
      }
    }
  }),
);
out.sort((a, b) => a.name.localeCompare(b.name));

const withParts = out.filter((o) => o.parts.length > 0);
const withSpin = out.filter((o) => o.spinnable.length > 0);
console.log(`${out.length} models read, ${errs.length} unreadable`);
console.log(`  ${withParts.length} carry named parts`);
console.log(`  ${withSpin.length} carry a part a game would SPIN (wheel/rotor/blade/track)`);

if (argv.includes("--all")) {
  for (const o of out) console.log(`  ${o.name.padEnd(22)} ${o.parts.join(", ") || "—"}`);
} else {
  console.log("\nSpinnable parts:");
  for (const o of withSpin) console.log(`  ${o.name.padEnd(22)} ${o.spinnable.join(", ")}`);
}
if (errs.length) {
  console.log("\nUnreadable:");
  for (const e of errs) console.log(`  ${e.name}: ${e.error}`);
}

if (argv.includes("--write")) {
  if (errs.length) {
    // Same refusal as the animation census: a model whose head could not be
    // read would be written as "no parts", and a game would then bolt on a fake
    // wheel next to a real one. A wrong part list is worse than a missing file.
    console.error(`\n✖ ${errs.length} model(s) unreadable — refusing to write a partial parts file.`);
    process.exit(1);
  }
  const parts = {};
  for (const o of withParts) parts[o.name] = o.parts;
  const target = join(repo, "src/lib/assets/model-parts.json");
  writeFileSync(target, JSON.stringify(parts, null, 2) + "\n");
  console.log(`\nwrote src/lib/assets/model-parts.json (${Object.keys(parts).length} models with parts)`);
}
