#!/usr/bin/env node
/**
 * Publishes the Phase A CANARY GAME (PRD-3D-GAMES-AND-ASSETS §11–§12): one
 * internal, never-listed game whose whole job is to depend on the asset host
 * the way real kid games will — import map → engine URL → render a spinning
 * cube — and keep working, unattended, across normal deploys. It must be
 * green across ≥2 deploys BEFORE any kid game references an asset.
 *
 * The page self-reports: it draws PASS/FAIL into the DOM (`#canary-status`)
 * so a human check is a glance, and any fetch/render failure is visible
 * without devtools.
 *
 * Idempotent re-publish is fine — sites/{slug}/ is the game area, not the
 * append-only assets prefix. Usage:
 *   node --env-file=../Ariantra-Platform/.env scripts/publish-canary-game.mjs
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repo, 'src/lib/assets/manifest.json'), 'utf8'));
const engine = manifest.assets.find((a) => a.name === 'three' && a.type === 'engine');
if (!engine) {
  console.error('✗ no engine entry in the manifest — run vendor-three.mjs --upload first');
  process.exit(1);
}

const SLUG = 'canary-3d';
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>🐤</text></svg>">
<title>asset-host canary</title>
<script type="importmap">{"imports":{"three":"${engine.url}"}}</script>
<style>html,body{margin:0;height:100dvh;background:#111;color:#eee;font:16px system-ui}
#canary-status{position:fixed;top:8px;left:8px;padding:4px 10px;border-radius:6px}
.pass{background:#164}.fail{background:#a22}</style>
</head>
<body>
<div id="canary-status">loading engine…</div>
<script type="module">
const status = document.getElementById('canary-status');
try {
  const T = await import('three');
  const renderer = new T.WebGLRenderer();
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);
  const scene = new T.Scene();
  const cam = new T.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 100);
  cam.position.z = 3;
  const cube = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ color: 0x44aa88 }));
  scene.add(cube, new T.AmbientLight(0xffffff, 0.5), new T.DirectionalLight(0xffffff, 1));
  renderer.setAnimationLoop(() => { cube.rotation.x += 0.01; cube.rotation.y += 0.015; renderer.render(scene, cam); });
  status.textContent = 'PASS — engine ${engine.sha256.slice(0, 6)} served and rendering';
  status.className = 'pass';
} catch (e) {
  status.textContent = 'FAIL — ' + e.message;
  status.className = 'fail';
}
</script>
</body>
</html>
`;

const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET } = process.env;
const S3_PREFIX = process.env.S3_PREFIX || 'ariantra/';
if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET) {
  console.error('✗ needs AWS env (run with --env-file=../Ariantra-Platform/.env)');
  process.exit(1);
}
const client = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
await client.send(new PutObjectCommand({
  Bucket: S3_BUCKET,
  Key: `${S3_PREFIX}sites/${SLUG}/index.html`,
  Body: html,
  ContentType: 'text/html; charset=utf-8',
  // Short TTL — this page is the mutable dependent, only the assets are immutable.
  CacheControl: 'public, max-age=300',
}));
console.log(`✓ published https://${SLUG}.ariantra.com (engine ${engine.url})`);
console.log('  open it — the badge must read PASS. It now rides every deploy via the standing smoke.');
