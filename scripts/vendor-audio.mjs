#!/usr/bin/env node
/**
 * The CC0 audio pipeline (PRD-3D-GAMES-AND-ASSETS §4): download → transcode
 * to MP3 → hash-name → publish to the immutable asset host → verify →
 * manifest. Sibling of vendor-models.mjs; runs on the dev Mac at curation
 * time, never on the box (§6 ①).
 *
 * Sources are pinned per sound with the license-proof URL: Kenney audio
 * packs (CC0, License.txt in each zip) for SFX + the victory jingle, and
 * OpenGameArt pages whose license section shows CC0 for the music loops.
 *
 * Transcode: ffmpeg-static → MP3 mono 96 kbps 44.1 kHz (iOS-safe; OGG
 * rejected — PRD §4.3). Budgets: SFX ≤ 30 KB, music ≤ 400 KB and ≤ 30 s.
 * MP3's encoder gap means seamless looping is delivered by the playMusic
 * Web-Audio helper, NOT by the file (§10b R2).
 *
 * Stages (same contract as vendor-models.mjs):
 *   1. acquire    kit zips cached in .assets-out/cache/, direct files too
 *   2. transcode  ffmpeg → validate magic bytes + budget + duration
 *   3. upload     (--upload) PutObject, immutable Cache-Control, skip-if-exists
 *   4. verify     GET the public URL, re-hash, check headers
 *   5. manifest   write entries, then run the contract tests as the gate
 *
 * Without --upload it stops after stage 2 and prints what would happen.
 *   node --env-file=../Ariantra-Platform/.env scripts/vendor-audio.mjs --upload
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import ffmpegPath from 'ffmpeg-static';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repo, '.assets-out/audio');
const cacheDir = join(repo, '.assets-out/cache');
const manifestPath = join(repo, 'src/lib/assets/manifest.json');

const ASSET_HOST_ORIGIN = 'https://assets.ariantra.com';
const BUDGETS = { sfx: 30_000, music: 400_000 }; // keep in sync with BUDGET_BYTES (manifest.ts)
const MUSIC_MAX_SECONDS = 30;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const KENNEY_ZIPS = {
  'digital-audio': 'https://kenney.nl/media/pages/assets/digital-audio/216eac4753-1677590265/kenney_digital-audio.zip',
  'sci-fi-sounds': 'https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip',
  'impact-sounds': 'https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip',
  'interface-sounds': 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip',
  'music-jingles': 'https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip',
  // 2026-07-24: footsteps, doors, coins, page turns. Kenney's separate
  // "UI Audio" pack was NOT added — interface-sounds (already pinned above)
  // already carries confirm/error/back/select/toggle, so a second download
  // would buy almost nothing.
  'rpg-audio': 'https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip',
};
const KENNEY_PAGE = (kit) => `https://kenney.nl/assets/${kit}`;

// ── the curated set (PRD §4.5: ~10 SFX + 3 music) ────────────────────────────
// kind 'kenney': file is the ogg name inside the kit zip (matched by suffix).
// kind 'url': a direct CC0 file; sourceUrl = the page proving the license.
const SOUNDS = [
  { name: 'jump', type: 'sfx', source: { kind: 'kenney', kit: 'digital-audio', file: 'phaseJump1.ogg' } },
  { name: 'coin_pickup', type: 'sfx', source: { kind: 'kenney', kit: 'digital-audio', file: 'threeTone1.ogg' } },
  { name: 'hit', type: 'sfx', source: { kind: 'kenney', kit: 'impact-sounds', file: 'impactGeneric_light_000.ogg' } },
  { name: 'explosion', type: 'sfx', source: { kind: 'kenney', kit: 'sci-fi-sounds', file: 'explosionCrunch_000.ogg' } },
  { name: 'click', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'click_001.ogg' } },
  { name: 'powerup', type: 'sfx', source: { kind: 'kenney', kit: 'digital-audio', file: 'powerUp1.ogg' } },
  { name: 'game_over', type: 'sfx', source: { kind: 'kenney', kit: 'digital-audio', file: 'lowDown.ogg' } },
  { name: 'win', type: 'sfx', source: { kind: 'kenney', kit: 'digital-audio', file: 'highUp.ogg' } },
  { name: 'laser', type: 'sfx', source: { kind: 'kenney', kit: 'digital-audio', file: 'laser1.ogg' } },
  // thrusterFire is a 5 s burn — trim to a 1.2 s whoosh (fade-out avoids a click).
  { name: 'whoosh', type: 'sfx', source: { kind: 'kenney', kit: 'sci-fi-sounds', file: 'thrusterFire_000.ogg' }, trimSeconds: 1.2 },

  // ── SFX batch 2 (2026-07-24). The catalog had exactly ONE UI sound (`click`)
  // against a menu/button/error vocabulary every game needs.
  { name: 'confirm', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'confirmation_001.ogg' } },
  { name: 'error', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'error_002.ogg' } },
  { name: 'back', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'back_001.ogg' } },
  { name: 'select', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'select_001.ogg' } },
  { name: 'toggle', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'toggle_001.ogg' } },
  { name: 'open_menu', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'open_001.ogg' } },
  { name: 'close_menu', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'close_001.ogg' } },
  { name: 'drop', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'drop_001.ogg' } },
  { name: 'scroll', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'scroll_001.ogg' } },
  { name: 'question', type: 'sfx', source: { kind: 'kenney', kit: 'interface-sounds', file: 'question_001.ogg' } },
  { name: 'pop', type: 'sfx', source: { kind: 'kenney', kit: 'digital-audio', file: 'pepSound1.ogg' } },
  { name: 'zap', type: 'sfx', source: { kind: 'kenney', kit: 'digital-audio', file: 'zap1.ogg' } },
  // World sounds — footsteps/doors/coins are the next most-asked-for after UI.
  { name: 'footstep', type: 'sfx', source: { kind: 'kenney', kit: 'rpg-audio', file: 'footstep00.ogg' } },
  { name: 'door_open', type: 'sfx', source: { kind: 'kenney', kit: 'rpg-audio', file: 'doorOpen_1.ogg' } },
  { name: 'door_close', type: 'sfx', source: { kind: 'kenney', kit: 'rpg-audio', file: 'doorClose_1.ogg' } },
  { name: 'coins', type: 'sfx', source: { kind: 'kenney', kit: 'rpg-audio', file: 'handleCoins.ogg' } },
  { name: 'page_turn', type: 'sfx', source: { kind: 'kenney', kit: 'rpg-audio', file: 'bookFlip1.ogg' } },
  { name: 'chop', type: 'sfx', source: { kind: 'kenney', kit: 'rpg-audio', file: 'chop.ogg' } },
  // Music: loops loop via the Web-Audio helper (R2); the jingle is one-shot.
  {
    name: 'bg_loop_upbeat', type: 'music',
    source: { kind: 'url', url: 'https://opengameart.org/sites/default/files/TremLoadingloopl.wav' },
    sourceUrl: 'https://opengameart.org/content/loading-screen-loop',
  },
  {
    name: 'bg_loop_chill', type: 'music',
    source: { kind: 'url', url: 'https://opengameart.org/sites/default/files/Relaxing.mp3' },
    sourceUrl: 'https://opengameart.org/content/calm-loop',
  },
  // ── Music batch 2 (2026-07-24). Three loops was too few to give a game a
  // mood. All CC0, license checked on each asset page individually — OGA hosts
  // CC-BY and GPL side by side, and "City Loop" was REJECTED on exactly that
  // (CC-BY-SA 3.0, needs attribution the manifest contract forbids).
  //
  // KNOWN QUALITY CAVEAT: playful and dreamy are longer than the 400 KB / 30 s
  // music budget allows, so they are cut at 28 s with trimSeconds' 0.2 s
  // fade-out. That fade repeats on every loop cycle as an audible dip — the
  // cost of the budget, not a mastering choice. gentle (16.7 s) and swing
  // (25.0 s) fit naturally and are untouched. If loop quality is ever
  // complained about, the fix is a longer budget (or per-entry bitrate), not
  // a different track.
  {
    name: 'bg_loop_playful', type: 'music',
    source: { kind: 'url', url: 'https://opengameart.org/sites/default/files/happy_adveture.mp3' },
    sourceUrl: 'https://opengameart.org/content/happy-adventure-loop', trimSeconds: 28,
  },
  {
    name: 'bg_loop_dreamy', type: 'music',
    source: { kind: 'url', url: 'https://opengameart.org/sites/default/files/Heavenly%20Loop_0.ogg' },
    sourceUrl: 'https://opengameart.org/content/heavenly-loop', trimSeconds: 28,
  },
  {
    name: 'bg_loop_gentle', type: 'music',
    source: { kind: 'url', url: 'https://opengameart.org/sites/default/files/A%20Brand%20New%20Wisdom.ogg' },
    sourceUrl: 'https://opengameart.org/content/short-loops-background-music-pack', trimSeconds: 28,
  },
  {
    name: 'bg_loop_swing', type: 'music',
    source: { kind: 'url', url: 'https://opengameart.org/sites/default/files/Swinging%20Sweet_0.ogg' },
    sourceUrl: 'https://opengameart.org/content/short-loops-background-music-pack', trimSeconds: 28,
  },
  // Kenney jingles are ~1 s stingers — played one-shot via playSound, not looped.
  { name: 'jingle_win', type: 'music', source: { kind: 'kenney', kit: 'music-jingles', file: 'jingles_NES13.ogg' } },
];

await mkdir(outDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function acquire(sound) {
  const dir = join(cacheDir, `audio-${sound.name}`);
  await mkdir(dir, { recursive: true });
  if (sound.source.kind === 'kenney') {
    const zipPath = join(cacheDir, `kenney_${sound.source.kit}.zip`);
    if (!existsSync(zipPath)) {
      console.log(`  ↓ ${KENNEY_ZIPS[sound.source.kit]}`);
      await download(KENNEY_ZIPS[sound.source.kit], zipPath);
    }
    execFileSync('unzip', ['-o', '-j', zipPath, `*${sound.source.file}`, '-d', dir], { stdio: 'pipe' });
    const extracted = readdirSync(dir).find((f) => f.endsWith(sound.source.file));
    if (!extracted) throw new Error(`${sound.name}: ${sound.source.file} not found in ${sound.source.kit}`);
    return join(dir, extracted);
  }
  const raw = join(dir, sound.source.url.split('/').pop());
  console.log(`  ↓ ${sound.source.url}`);
  await download(sound.source.url, raw);
  return raw;
}

/** ffmpeg → MP3 mono 96k (optionally trimmed with a fade-out). Returns { seconds }. */
function transcode(inPath, outPath, trimSeconds) {
  const trimArgs = trimSeconds
    ? ['-t', String(trimSeconds), '-af', `afade=t=out:st=${(trimSeconds - 0.2).toFixed(2)}:d=0.2`]
    : [];
  execFileSync(
    ffmpegPath,
    ['-y', '-i', inPath, '-ac', '1', '-ar', '44100', '-b:a', '96k', '-map', 'a:0', ...trimArgs, outPath],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  // Duration comes from a second -i probe of the OUTPUT (encoder stderr is
  // about the input); cheap and dependency-free (no ffprobe in ffmpeg-static).
  let probe = '';
  try {
    execFileSync(ffmpegPath, ['-i', outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    probe = err.stderr?.toString() ?? '';
  }
  const m = probe.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
  return { seconds };
}

const prepared = [];
for (const sound of SOUNDS) {
  console.log(`● ${sound.name} (${sound.type})`);
  const rawPath = await acquire(sound);
  const mp3Path = join(outDir, `${sound.name}.mp3`);
  const { seconds } = transcode(rawPath, mp3Path, sound.trimSeconds);
  const bytes = await readFile(mp3Path);

  if (!(bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
    throw new Error(`${sound.name}: transcoded output is not an MP3 (magic bytes)`);
  }
  if (bytes.length > BUDGETS[sound.type]) {
    throw new Error(`${sound.name}: ${bytes.length} bytes > ${sound.type} budget ${BUDGETS[sound.type]} (PRD §8)`);
  }
  if (sound.type === 'music' && !(seconds <= MUSIC_MAX_SECONDS)) {
    throw new Error(`${sound.name}: ${seconds}s > ${MUSIC_MAX_SECONDS}s music cap (PRD §4.3) — trim or pick a shorter loop`);
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileName = `${sound.name}.${sha256.slice(0, 6)}.mp3`;
  await writeFile(join(outDir, fileName), bytes);
  prepared.push({ sound, bytes, sha256, fileName, url: `${ASSET_HOST_ORIGIN}/${fileName}` });
  console.log(`  ✓ ${fileName} (${(bytes.length / 1024).toFixed(1)} KB${Number.isFinite(seconds) ? `, ${seconds.toFixed(1)}s` : ''})`);
}

if (!process.argv.includes('--upload')) {
  console.log(`\nDry run (no --upload). Next stages would, per file:`);
  console.log(`  3. PutObject → {S3_PREFIX}sites/assets/{file}  Cache-Control: ${CACHE_CONTROL} (skip-if-exists)`);
  console.log(`  4. GET the public URL and verify sha256 + immutable header`);
  console.log(`  5. write manifest entries + run the assets test suite`);
  process.exit(0);
}

// ── stage 3+4: upload + public verify (append-only; upload-then-verify) ─────
const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET } = process.env;
const S3_PREFIX = process.env.S3_PREFIX || 'ariantra/';
if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET) {
  console.error('✗ --upload needs AWS env (run with: node --env-file=../Ariantra-Platform/.env scripts/vendor-audio.mjs --upload)');
  process.exit(1);
}
const client = new S3Client({ region: AWS_REGION, credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });

for (const p of prepared) {
  const key = `${S3_PREFIX}sites/assets/${p.fileName}`;
  let alreadyThere = false;
  try {
    await client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    alreadyThere = true;
    console.log(`• ${key} already exists — append-only host, leaving it untouched`);
  } catch { /* 404 = new object */ }

  if (!alreadyThere) {
    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET, Key: key, Body: p.bytes,
      ContentType: 'audio/mpeg', CacheControl: CACHE_CONTROL,
    }));
    console.log(`✓ uploaded s3://${S3_BUCKET}/${key}`);
  }

  const res = await fetch(p.url);
  if (!res.ok) {
    console.error(`✗ ${p.url} → HTTP ${res.status} — NOT adding a manifest entry (upload-then-verify)`);
    process.exit(1);
  }
  const served = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(served).digest('hex') !== p.sha256) {
    console.error(`✗ ${p.fileName}: served hash ≠ built hash — refusing the manifest entry`);
    process.exit(1);
  }
  if (!(res.headers.get('cache-control') || '').includes('immutable')) {
    console.error(`✗ ${p.fileName}: served Cache-Control lacks immutable — fix headers first`);
    process.exit(1);
  }
  console.log(`✓ verified ${p.url} (200, sha256 match, immutable)`);
}

// ── stage 5: manifest entries, gated by the contract tests ──────────────────
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const p of prepared) {
  const entryJson = {
    name: p.sound.name,
    type: p.sound.type,
    url: p.url,
    bytes: p.bytes.length,
    license: 'CC0',
    sourceUrl: p.sound.sourceUrl ?? KENNEY_PAGE(p.sound.source.kit),
    sha256: p.sha256,
  };
  const existing = manifest.assets.findIndex((a) => a.name === p.sound.name);
  if (existing >= 0) manifest.assets[existing] = entryJson;
  else manifest.assets.push(entryJson);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

execFileSync('npx', ['vitest', 'run', 'src/lib/assets/'], { cwd: repo, stdio: 'inherit' });
console.log(`✓ manifest entries written and contract tests green — commit src/lib/assets/manifest.json`);
