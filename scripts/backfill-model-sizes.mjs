// Backfill `size` onto manifest model entries that predate the field
// (2026-08-08 — docs/BUG-FIX-LOG.md, fragmented race tracks).
//
// WHY THIS EXISTS. vendor-models.mjs now measures every model it publishes and
// writes the metres into the manifest, but it only reaches stage 5 (the
// manifest write) on an --upload run. Every model already on the asset host has
// unchanged bytes, so a re-upload would be a no-op that still needs production
// credentials — an absurd price for a field we can measure locally.
//
// The measurement here is not a re-derivation: `.assets-out/models/` holds the
// EXACT published artifact for each entry, and this script only touches an
// entry whose file both (a) is named for that entry's hash fragment and (b)
// re-hashes to the full sha256 in the manifest. Anything that fails either
// check is reported and left alone — it needs a real vendor run, not a patch.
//
// One-off by design: after this, vendor-models.mjs writes `size` itself.
// Re-running is safe (idempotent) and doubles as a verification pass.
//
//   node scripts/backfill-model-sizes.mjs          # report only
//   node scripts/backfill-model-sizes.mjs --write  # update manifest.json

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repo, 'src/lib/assets/manifest.json');
const outDir = join(repo, '.assets-out/models');

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const write = process.argv.includes('--write');

let measured = 0;
const skinned = [];
const unverifiable = [];

for (const entry of manifest.assets) {
  if (entry.type !== 'model') continue;
  const file = join(outDir, `${entry.name}.${entry.sha256.slice(0, 6)}.glb`);
  if (!existsSync(file)) {
    unverifiable.push(`${entry.name}: no local copy of the published artifact`);
    continue;
  }
  const bytes = readFileSync(file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== entry.sha256) {
    // The filename fragment matched but the full hash did not — measuring this
    // would describe bytes nobody is serving.
    unverifiable.push(`${entry.name}: local bytes do not hash to the manifest sha256`);
    continue;
  }
  const doc = await io.read(file);
  if (doc.getRoot().listSkins().length > 0) {
    // Same rule as the vendor pipeline: a skinned mesh's POSITION accessor is
    // in bind space and it ignores its node transform per spec, so getBounds()
    // would return a confident wrong answer. Omit rather than fabricate.
    skinned.push(entry.name);
    delete entry.size;
    continue;
  }
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const b = getBounds(scene);
  entry.size = [0, 1, 2].map((i) => Math.round((b.max[i] - b.min[i]) * 1000) / 1000);
  measured++;
}

console.log(`measured ${measured} model(s) from their published bytes`);
console.log(`skipped ${skinned.length} skinned model(s) — no trustworthy rest-pose bbox:`);
console.log(`  ${skinned.join(', ')}`);
if (unverifiable.length) {
  console.log(`\n⚠ ${unverifiable.length} entr(ies) left without a size — re-vendor these:`);
  for (const u of unverifiable) console.log(`  ${u}`);
}

if (!write) {
  console.log('\nReport only. Re-run with --write to update manifest.json.');
  process.exit(0);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('\n✓ manifest.json updated — run `npx vitest run src/lib/assets/` to gate it');
