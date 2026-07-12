#!/usr/bin/env node
/**
 * Standing checks that the immutability contract actually holds on the live
 * asset host (PRD-3D-GAMES-AND-ASSETS §10–§11). Attack it, don't just read
 * config. Exits non-zero on ANY failure so it can gate a deploy.
 *
 * Default (no creds needed) — SERVING SMOKE, run post-deploy forever:
 *   for every manifest entry: GET → 200, immutable Cache-Control,
 *   CORS `access-control-allow-origin: *`, served bytes re-hash to the
 *   manifest sha256 (a corrupted or swapped object cannot bear the name).
 *
 * --attack (needs AWS env; run at Phase A setup and after any bucket change):
 *   DELETE-ATTEMPT on a dedicated canary object with the app's credentials.
 *   Expected: AccessDenied (the MarksZen-applied deny-delete policy, §10.3).
 *   If the delete SUCCEEDS the contract is NOT in force — the script restores
 *   the canary and fails loudly. Creates the canary on first run.
 *
 *   node --env-file=../Ariantra-Platform/.env scripts/assets-contract-check.mjs --attack
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repo, 'src/lib/assets/manifest.json'), 'utf8'));

const ASSET_HOST_ORIGIN = 'https://assets.ariantra.com';
let failures = 0;
const fail = (msg) => { failures += 1; console.error(`✗ ${msg}`); };

// ── serving smoke ────────────────────────────────────────────────────────────
if (manifest.assets.length === 0) {
  console.log('• manifest is empty — nothing on the host to smoke-check yet (Phase A pre-upload)');
}
for (const a of manifest.assets) {
  let res;
  try {
    res = await fetch(a.url, { headers: { Origin: 'https://any-game.ariantra.com' } });
  } catch (e) {
    fail(`${a.url} unreachable: ${e.message}`);
    continue;
  }
  if (!res.ok) { fail(`${a.url} → HTTP ${res.status}`); continue; }

  const cache = res.headers.get('cache-control') || '';
  if (!cache.includes('immutable')) fail(`${a.name}: Cache-Control "${cache}" lacks immutable`);

  const cors = res.headers.get('access-control-allow-origin');
  if (cors !== '*') fail(`${a.name}: access-control-allow-origin is "${cors}" (want * — §10.4; saved-file play has origin null)`);

  // The header must be UNCONDITIONAL — present even with no Origin header.
  // Conditional CORS (e.g. managed SimpleCORS) + immutable year-long caching
  // means any client that ever receives a header-less variant caches it
  // forever and every later module/GLB fetch fails (BUG-FIX-LOG 2026-07-12).
  const bare = await fetch(a.url, { method: 'HEAD' });
  const bareCors = bare.headers.get('access-control-allow-origin');
  if (bareCors !== '*') fail(`${a.name}: CORS header is CONDITIONAL (absent without an Origin header) — use an unconditional custom response header at the edge (§10.4)`);

  const body = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(body).digest('hex');
  if (sha !== a.sha256) fail(`${a.name}: served sha256 ${sha.slice(0, 12)}… ≠ manifest ${a.sha256.slice(0, 12)}…`);
  if (body.length !== a.bytes) fail(`${a.name}: served ${body.length} bytes ≠ manifest ${a.bytes}`);

  if (failures === 0) console.log(`✓ ${a.name} — 200, immutable, CORS *, hash match (${(body.length / 1024).toFixed(0)} KB, via: ${res.headers.get('via') || 'n/a'})`);
}

// ── delete-attempt attack test ───────────────────────────────────────────────
if (process.argv.includes('--attack')) {
  const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } =
    await import('@aws-sdk/client-s3');
  const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET } = process.env;
  const S3_PREFIX = process.env.S3_PREFIX || 'ariantra/';
  if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET) {
    fail('--attack needs AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_BUCKET');
  } else {
    const client = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    const canaryBody = 'immutability canary — if you can delete me, the contract is broken';
    const canarySha = createHash('sha256').update(canaryBody).digest('hex');
    const canaryKey = `${S3_PREFIX}sites/assets/canary.${canarySha.slice(0, 6)}.txt`;

    try {
      await client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: canaryKey }));
    } catch {
      await client.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: canaryKey, Body: canaryBody,
        ContentType: 'text/plain', CacheControl: 'public, max-age=31536000, immutable',
      }));
      console.log(`• created canary object ${canaryKey}`);
    }

    try {
      await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: canaryKey }));
      // Delete WORKED — the deny-delete policy is not in force. Restore, then fail.
      await client.send(new PutObjectCommand({
        Bucket: S3_BUCKET, Key: canaryKey, Body: canaryBody,
        ContentType: 'text/plain', CacheControl: 'public, max-age=31536000, immutable',
      }));
      fail('DELETE SUCCEEDED on the canary — deny-delete policy is NOT applied (canary restored). Coordinate §10.3 with the MarksZen owner before any game references an asset.');
    } catch (e) {
      if (e.name === 'AccessDenied' || e.$metadata?.httpStatusCode === 403) {
        console.log('✓ delete attempt on canary → AccessDenied (deny-delete policy holds)');
      } else {
        fail(`delete attempt failed with unexpected error ${e.name}: ${e.message}`);
      }
    }

    // The canary must also serve publicly — it doubles as a host liveness probe.
    const pub = await fetch(`${ASSET_HOST_ORIGIN}/canary.${canarySha.slice(0, 6)}.txt`);
    if (!pub.ok) fail(`canary not publicly served → HTTP ${pub.status} (DNS/CloudFront for assets.ariantra.com not live?)`);
    else console.log('✓ canary serves publicly through the asset host');
  }
}

if (failures) {
  console.error(`\n${failures} contract failure(s).`);
  process.exit(1);
}
console.log('\nAll asset-host contract checks passed.');
