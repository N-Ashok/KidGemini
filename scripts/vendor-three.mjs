#!/usr/bin/env node
/**
 * Bundles the "three" npm package (+ GLTFLoader) into ONE self-contained,
 * import-free ES module and publishes it to the shared immutable asset host
 * (assets.ariantra.com — PRD-3D-GAMES-AND-ASSETS Part I, §4).
 *
 * Phase-0 embedded this bundle as a base64 data: URI inside each game's HTML;
 * the end-state SERVES it instead: the bundle is content-hash-named
 * (three.{sha256[0:6]}.js), uploaded once with year-long immutable caching,
 * and referenced by URL from every 3D game. An engine upgrade is a NEW file
 * under a new hash — old games keep their engine forever.
 *
 * Runs on the dev Mac at curation time, never on the box (§6). Stages:
 *
 *   1. build     esbuild-bundle the curated export list into .assets-out/
 *   2. upload    (--upload) PutObject to s3://{S3_BUCKET}/{S3_PREFIX}sites/assets/
 *                with Cache-Control: public, max-age=31536000, immutable
 *                — skipped if the object already exists (append-only host)
 *   3. verify    GET https://assets.ariantra.com/{file} and re-hash the served
 *                bytes; refuse the manifest entry on ANY mismatch
 *                (upload-then-verify, never trust-then-404 — §4.4)
 *   4. manifest  write the entry into src/lib/assets/manifest.json, then run
 *                the manifest contract tests as the authoritative gate
 *
 * Without --upload it stops after stage 1 and prints what stages 2–4 would do.
 * AWS env comes from the platform repo (this repo has none):
 *   node --env-file=../Ariantra-Platform/.env scripts/vendor-three.mjs --upload
 */

import { build } from 'esbuild';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repo, '.assets-out');
const manifestPath = join(repo, 'src/lib/assets/manifest.json');

const ASSET_HOST_ORIGIN = 'https://assets.ariantra.com';
const ENGINE_BUDGET_BYTES = 650_000; // keep in sync with BUDGET_BYTES.engine (manifest.ts)
const CACHE_CONTROL = 'public, max-age=31536000, immutable'; // safe ONLY because of hash naming (BUG_LOG #6: always explicit)

// Named exports only (not `export *`) — esbuild tree-shakes to just what
// CHILD_SYSTEM_PROMPT teaches Gemini to use. Add a name here AND to the
// prompt together if the 3D vocabulary grows.
const THREE_EXPORTS = [
  'Scene', 'PerspectiveCamera', 'WebGLRenderer', 'Clock', 'Color', 'Fog',
  'Group', 'Vector3', 'Box3',
  'BoxGeometry', 'SphereGeometry', 'ConeGeometry', 'CylinderGeometry',
  'PlaneGeometry', 'TorusGeometry', 'CapsuleGeometry', 'RingGeometry',
  // 2026-07-20 ("DoubleSide" incident): custom flat outlines — tracks, roads,
  // stars. The model reached for these untaught and killed a game on its
  // import line; now they're vendored AND taught.
  'Shape', 'ShapeGeometry', 'DoubleSide',
  'MeshStandardMaterial', 'MeshBasicMaterial', 'Mesh',
  'AmbientLight', 'DirectionalLight', 'PointLight', 'HemisphereLight',
  'AnimationMixer', // animated library models (dino walks) — Phase C
  // 2026-07-29: prod logs showed the model reaching for these and dying on the
  // import line — Quaternion x4, plus Euler, Matrix4, MathUtils, Raycaster —
  // each costing a corrective retry. They are already inside the bundle as
  // internal dependencies, so exporting all six costs +1.29 KB total
  // (617.7 -> 619.0 KB, budget 650). Rotation and aiming maths is exactly what
  // the physics playbook pushes games toward, so this closes the gap it opened.
  'Quaternion', 'Euler', 'Matrix4', 'Vector2', 'MathUtils', 'Raycaster',
];

// ── stage 1: build ───────────────────────────────────────────────────────────
// Perf Panel (2026-07-30, docs/2026-07-30_PRD_PreviewPerfPanel.md §2): two
// ADDITIVE wraps so the debug perf-probe can see inside the private
// renderer/AnimationMixer instances every generated game constructs. Both
// call straight through to the real constructor — zero behavior change for
// any existing game; they only register bookkeeping on window.__arPerf,
// the same registry runtime-helpers.ts's loadModel() populates (models +
// rootNames). WebGLRenderer/AnimationMixer are pulled out of the passthrough
// export list and re-exported as thin subclasses instead.
const WRAPPED_EXPORTS = ['WebGLRenderer', 'AnimationMixer'];
const PASSTHROUGH_EXPORTS = THREE_EXPORTS.filter((n) => !WRAPPED_EXPORTS.includes(n));

const entry = [
  `import {`,
  `  ${PASSTHROUGH_EXPORTS.join(',\n  ')},`,
  // InstancedMesh backs loadModelBatch() (runtime-helpers.ts) — internal to
  // that helper, not taught to Gemini as an importable name, same precedent
  // as MeshoptDecoder below. Aliased so it isn't accidentally swept into the
  // PASSTHROUGH_EXPORTS join below (which IS the taught/lockstep-tested list).
  `  InstancedMesh as __ArInstancedMesh,`,
  `  WebGLRenderer as __ArRealWebGLRenderer,`,
  `  AnimationMixer as __ArRealAnimationMixer,`,
  `} from 'three';`,
  // GLTFLoader so games can load library models (PRD Part I). Lives outside
  // three's main entry, hence the second export line.
  `export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';`,
  // MeshoptDecoder because library models are gltfpack -cc compressed
  // (EXT_meshopt_compression — PRD §4.3); the loadModel helper wires it into
  // GLTFLoader. Not taught to Gemini — internal to the helper.
  `export { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';`,
  // SkeletonUtils.clone properly re-binds a skinned mesh's bones/skeleton on
  // clone (plain Object3D.clone() shares one skeleton across "clones", which
  // is exactly why loadModel() used to be called once per instance instead
  // of cloning — see the 2026-08-05 loadModel template-cache change). Same
  // "not taught to Gemini — internal to the helper" precedent as MeshoptDecoder.
  // The module has no default/namespace export, only named functions — wrap
  // them into the object shape runtime-helpers.ts's generated script expects
  // (SkeletonUtils.clone(...)).
  `import { clone as __ArSkeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';`,
  `export const SkeletonUtils = { clone: __ArSkeletonClone };`,
  `export { __ArInstancedMesh as InstancedMesh };`,
  `export { ${PASSTHROUGH_EXPORTS.join(', ')} };`,
  ``,
  `export class WebGLRenderer extends __ArRealWebGLRenderer {`,
  `  constructor(...args) {`,
  `    super(...args);`,
  `    try {`,
  `      window.__arPerf = window.__arPerf || { models: {} };`,
  `      window.__arPerf.renderer = this;`,
  `    } catch (e) { /* telemetry only — never break rendering */ }`,
  `  }`,
  `}`,
  `export class AnimationMixer extends __ArRealAnimationMixer {`,
  `  constructor(root, ...args) {`,
  `    super(root, ...args);`,
  `    try {`,
  `      window.__arPerf = window.__arPerf || { models: {} };`,
  `      window.__arPerf.animatedRoots = window.__arPerf.animatedRoots || new WeakSet();`,
  `      if (root) window.__arPerf.animatedRoots.add(root);`,
  `    } catch (e) { /* telemetry only — never break animation */ }`,
  `  }`,
  `}`,
].join('\n');

const result = await build({
  stdin: { contents: entry, resolveDir: repo, loader: 'js', sourcefile: 'three-entry.js' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2019',
  minify: true,
  legalComments: 'inline', // three.js is MIT — its notice must ride inside the served bundle
  write: false,
});

const source =
  `// GENERATED by scripts/vendor-three.mjs from the "three" npm package (MIT — notice preserved below). Do not edit.\n` +
  result.outputFiles[0].text;
const bytes = Buffer.from(source, 'utf8');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const fileName = `three.${sha256.slice(0, 6)}.js`;
const url = `${ASSET_HOST_ORIGIN}/${fileName}`;

for (const mustContain of ['WebGLRenderer', 'GLTFLoader', 'PerspectiveCamera', 'MeshoptDecoder', 'SkeletonUtils', 'InstancedMesh']) {
  if (!source.includes(mustContain)) {
    console.error(`✗ bundle is missing ${mustContain} — refusing`);
    process.exit(1);
  }
}
if (bytes.length > ENGINE_BUDGET_BYTES) {
  console.error(`✗ bundle is ${bytes.length} bytes > engine budget ${ENGINE_BUDGET_BYTES} — refusing (PRD §8)`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, fileName), bytes);
console.log(`✓ built ${fileName} (${(bytes.length / 1024).toFixed(0)} KB, sha256 ${sha256.slice(0, 12)}…) → .assets-out/`);

if (!process.argv.includes('--upload')) {
  console.log(`\nDry run (no --upload). Next stages would:`);
  console.log(`  2. PutObject → {S3_PREFIX}sites/assets/${fileName}  Cache-Control: ${CACHE_CONTROL}`);
  console.log(`  3. GET ${url} and verify sha256`);
  console.log(`  4. write manifest entry + run manifest contract tests`);
  process.exit(0);
}

// ── stage 2: upload (append-only: existing object is never rewritten) ───────
const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET } = process.env;
const S3_PREFIX = process.env.S3_PREFIX || 'ariantra/';
if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET) {
  console.error('✗ --upload needs AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_BUCKET');
  console.error('  (run with: node --env-file=../Ariantra-Platform/.env scripts/vendor-three.mjs --upload)');
  process.exit(1);
}
const client = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
const key = `${S3_PREFIX}sites/assets/${fileName}`;

let alreadyThere = false;
try {
  await client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  alreadyThere = true;
  console.log(`• ${key} already exists — append-only host, leaving it untouched`);
} catch { /* 404 = new object, proceed */ }

if (!alreadyThere) {
  await client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: bytes,
    ContentType: 'text/javascript',
    CacheControl: CACHE_CONTROL,
  }));
  console.log(`✓ uploaded s3://${S3_BUCKET}/${key}`);
}

// ── stage 3: verify through the public path before trusting ─────────────────
const res = await fetch(url);
if (!res.ok) {
  console.error(`✗ ${url} → HTTP ${res.status} — NOT adding a manifest entry (upload-then-verify).`);
  console.error(`  If DNS/CloudFront for assets.ariantra.com isn't live yet, that's the Phase A infra step.`);
  process.exit(1);
}
const served = Buffer.from(await res.arrayBuffer());
const servedSha = createHash('sha256').update(served).digest('hex');
if (servedSha !== sha256) {
  console.error(`✗ served bytes hash ${servedSha.slice(0, 12)}… ≠ built ${sha256.slice(0, 12)}… — refusing the manifest entry`);
  process.exit(1);
}
const cacheHeader = res.headers.get('cache-control') || '';
if (!cacheHeader.includes('immutable')) {
  console.error(`✗ served Cache-Control is "${cacheHeader}" (want immutable) — fix headers before the manifest entry`);
  process.exit(1);
}
console.log(`✓ verified ${url} (200, sha256 match, immutable)`);

// ── stage 4: manifest entry, gated by the contract tests ────────────────────
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entryJson = {
  name: 'three',
  type: 'engine',
  url,
  bytes: bytes.length,
  license: 'MIT', // engine-only exception; library assets stay CC0-only (manifest.ts)
  sourceUrl: 'https://github.com/mrdoob/three.js',
  sha256,
};
const existing = manifest.assets.findIndex((a) => a.name === 'three');
if (existing >= 0) manifest.assets[existing] = entryJson;
else manifest.assets.push(entryJson);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

execFileSync('npx', ['vitest', 'run', 'src/lib/assets/manifest.test.ts'], { cwd: repo, stdio: 'inherit' });
console.log(`✓ manifest entry written and contract tests green — commit src/lib/assets/manifest.json`);
