#!/usr/bin/env node
/**
 * The CC0 model pipeline (PRD-3D-GAMES-AND-ASSETS §4): download → compress →
 * hash-name → publish to the immutable asset host → verify → manifest.
 * Sibling of vendor-three.mjs; runs on the dev Mac at curation time, never on
 * the box (§6 ①).
 *
 * Sources are pinned per model below with the license-proof URL (the Kenney
 * asset page or the poly.pizza model page whose license section shows CC0) —
 * `sourceUrl` in the manifest IS the proof trail (§4.4). CC0-only; the
 * manifest validators refuse anything else.
 *
 * Compression: gltf-transform + meshoptimizer (EXT_meshopt_compression +
 * quantization) — the only way the animated dino fits the 100 KB model
 * budget. The engine bundle therefore ships MeshoptDecoder
 * (vendor-three.mjs) and the loadModel helper wires it into GLTFLoader
 * (src/lib/assets/inject.ts). NOT gltfpack: its npm WASM build corrupts
 * embedded textures (data:image/png;base64,ERR/ — every Kenney model went
 * white, caught in the gallery visual pass 2026-07-12); gltf-transform
 * passes texture bytes through untouched.
 *
 * Stages (same contract as vendor-three.mjs):
 *   1. acquire   download the source file (Kenney kit zips are cached in
 *                .assets-out/cache/; direct GLBs re-download)
 *   2. compress  gltfpack -cc → validate magic bytes + ≤ 100 KB budget
 *   3. upload    (--upload) PutObject with immutable Cache-Control,
 *                skip-if-exists (append-only host)
 *   4. verify    GET the public URL, re-hash, check headers — refuse the
 *                manifest entry on ANY mismatch (upload-then-verify)
 *   5. manifest  write entries, then run the contract tests as the gate
 *
 * Without --upload it stops after stage 2 and prints what would happen.
 *   node --env-file=../Ariantra-Platform/.env scripts/vendor-models.mjs --upload
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, simplify, meshopt } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repo, '.assets-out/models');
const cacheDir = join(repo, '.assets-out/cache');
const manifestPath = join(repo, 'src/lib/assets/manifest.json');

const ASSET_HOST_ORIGIN = 'https://assets.ariantra.com';
const MODEL_BUDGET_BYTES = 100_000; // keep in sync with BUDGET_BYTES.model (manifest.ts)
const CACHE_CONTROL = 'public, max-age=31536000, immutable'; // hash naming makes this safe (BUG_LOG #6: always explicit)

// ── the curated set (Decision H: car, dino, tree, coin, rocket first) ────────
// kind 'kenney-zip': the kit zip is the download, innerPath the GLB inside it;
// sourceUrl = the kit page (its License.txt says CC0, kept in the zip).
// kind 'url': a direct CC0 GLB; sourceUrl = the poly.pizza model page whose
// license section shows CC0 (checked at curation time, 2026-07-12).
const MODELS = [
  {
    name: 'car',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/race.glb' },
    sourceUrl: 'https://kenney.nl/assets/car-kit',
  },
  {
    name: 'dino',
    // Velociraptor by Quaternius (animated) — CC0 per the model page.
    // The six source clips alone are ~87 KB — keep the three a kid's game
    // actually uses (run, idle, attack) to land under the 100 KB budget.
    source: { kind: 'url', url: 'https://static.poly.pizza/c1f0c4cb-c84f-415c-8323-d8cb871a2126.glb' },
    sourceUrl: 'https://poly.pizza/m/cnlGH2UcDd',
    keepAnimations: ['Run', 'Idle', 'Attack'],
  },
  {
    name: 'tree',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/tree.glb' },
    sourceUrl: 'https://kenney.nl/assets/platformer-kit',
  },
  {
    name: 'coin',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/coin-gold.glb' },
    sourceUrl: 'https://kenney.nl/assets/platformer-kit',
  },
  {
    name: 'rocket',
    // "Rocket" by hat_my_guy — CC0 per the model page.
    source: { kind: 'url', url: 'https://static.poly.pizza/244c027c-40f0-45ca-a707-0f8e855c9831.glb' },
    sourceUrl: 'https://poly.pizza/m/9awwTQWYux',
  },

  // ── Phase F fill-out (2026-07-12): 15 more, → 20 total (§14 cap: 25). ──────
  // poly.pizza pages below were CC0-checked by scripted scan (license section
  // = publicdomain/zero) at curation time; every candidate was size-probed
  // through this exact transform before being pinned. Animated Quaternius
  // models carry many clips — keepAnimations trims to what a kid's game calls
  // (the dry run prints each model's clip names; budget errors guide the trim).
  // Rejected as over-budget even fully trimmed: Shiba Inu ~241 KB, Husky
  // ~266 KB, both Quaternius horses ~305 KB (mesh-heavy, and simplify()
  // no-ops on skinned meshes). No CC0 fixed-wing airplane surfaced — flying
  // is covered by helicopter + spaceship + ufo (+ rocket above).
  {
    name: 'dog',
    // "Pug" by Quaternius (animated).
    source: { kind: 'url', url: 'https://static.poly.pizza/094335c0-632a-45f5-8583-27d5cab53b54.glb' },
    sourceUrl: 'https://poly.pizza/m/1gXKv15ik8',
    keepAnimations: ['Idle', 'Jump'],
  },
  {
    name: 'cat',
    // "Cat" by Quaternius (animated).
    source: { kind: 'url', url: 'https://static.poly.pizza/67f5e3fe-37ee-4c86-95c8-d269d8c9f8ba.glb' },
    sourceUrl: 'https://poly.pizza/m/qKICY6xla2',
    keepAnimations: ['Run', 'Idle', 'Walk'],
  },
  {
    name: 'fish',
    // "Clownfish" by Quaternius (animated swim).
    source: { kind: 'url', url: 'https://static.poly.pizza/f28280ed-888d-4d9b-9d13-af2baf36b749.glb' },
    sourceUrl: 'https://poly.pizza/m/769fHo3eEB',
    keepAnimations: ['Swimming_Normal', 'Swimming_Fast', 'Out_Of_Water'],
  },
  {
    name: 'boat',
    // "Sail Boat" by Quaternius.
    source: { kind: 'url', url: 'https://static.poly.pizza/b1d42c7e-152a-4d56-a754-cca000a5abad.glb' },
    sourceUrl: 'https://poly.pizza/m/BgSZXwmm7k',
  },
  {
    name: 'robot',
    // "Robot Enemy" by Quaternius (animated; the "Animated Robot" and the
    // Polygonal Mind robot both probed over budget).
    source: { kind: 'url', url: 'https://static.poly.pizza/9c45ab2b-c46a-4319-bc2a-88d6dbbc8e42.glb' },
    sourceUrl: 'https://poly.pizza/m/1gNo5ezvmr',
    keepAnimations: ['Run', 'Idle', 'Walk', 'Jump'],
  },
  {
    name: 'tower',
    // "Tower" by Quaternius (castle tower).
    source: { kind: 'url', url: 'https://static.poly.pizza/749bb696-9058-4290-a5d6-92fb97a9a641.glb' },
    sourceUrl: 'https://poly.pizza/m/iuMDwgTRMU',
  },
  {
    name: 'spaceship',
    // "Spaceship" by Quaternius.
    source: { kind: 'url', url: 'https://static.poly.pizza/e8817981-bfc4-448d-822f-5b76a5983675.glb' },
    sourceUrl: 'https://poly.pizza/m/uCeLfsdmNP',
  },
  {
    name: 'ufo',
    // "Ufo" by hat_my_guy.
    source: { kind: 'url', url: 'https://static.poly.pizza/8e0d157d-58e1-415e-b48c-f194e653c274.glb' },
    sourceUrl: 'https://poly.pizza/m/NgURFR5T9m',
  },
  {
    name: 'helicopter',
    // "Helicopter" by kazuma.
    source: { kind: 'url', url: 'https://static.poly.pizza/e3dfeb10-5525-4a39-83d8-13a709aaca4b.glb' },
    sourceUrl: 'https://poly.pizza/m/EQJ2MECUbx',
  },
  {
    name: 'ghost',
    // "Ghost" by Quaternius (animated).
    source: { kind: 'url', url: 'https://static.poly.pizza/810f60a2-6e45-4c4e-a0d5-da91cd7288bd.glb' },
    sourceUrl: 'https://poly.pizza/m/Iip30bDHmu',
    keepAnimations: ['Flying', 'Idle'],
  },
  {
    name: 'police',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/police.glb' },
    sourceUrl: 'https://kenney.nl/assets/car-kit',
  },
  {
    name: 'firetruck',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/firetruck.glb' },
    sourceUrl: 'https://kenney.nl/assets/car-kit',
  },
  {
    name: 'star',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/star.glb' },
    sourceUrl: 'https://kenney.nl/assets/platformer-kit',
  },
  {
    name: 'key',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/key.glb' },
    sourceUrl: 'https://kenney.nl/assets/platformer-kit',
  },
  {
    name: 'chest',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/chest.glb' },
    sourceUrl: 'https://kenney.nl/assets/platformer-kit',
  },

  // ── Cities / forest / aliens / animals (2026-07-13): 7 more, → 27 total ────
  // (owner decision 2026-07-13: prompt cap raised 25 → 30, PRD §14).
  // Rejected over-budget even clip-trimmed: Quaternius Deer ~260 KB, Fox
  // ~263 KB, two alien alternates 134–580 KB. NO CC0 fixed-wing airplane or
  // fighter jet exists on poly.pizza or Kenney (searched: plane, biplane,
  // aircraft, jet, fighter, cessna, propeller — all spaceships or 2D);
  // flying stays spaceship/helicopter/ufo/rocket until a new source appears.
  {
    name: 'skyscraper',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-commercial/a742d900eb-1753115042/kenney_city-kit-commercial_2.1.zip', innerPath: 'Models/GLB format/building-skyscraper-a.glb' },
    sourceUrl: 'https://kenney.nl/assets/city-kit-commercial',
  },
  {
    name: 'house',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip', innerPath: 'Models/GLB format/building-type-a.glb' },
    sourceUrl: 'https://kenney.nl/assets/city-kit-suburban',
  },
  {
    name: 'pine',
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/tree-pine.glb' },
    sourceUrl: 'https://kenney.nl/assets/platformer-kit',
  },
  {
    name: 'rock',
    // nature-kit is an older kit: models live under "GLTF format", vertex-colored.
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip', innerPath: 'Models/GLTF format/rock_largeA.glb' },
    sourceUrl: 'https://kenney.nl/assets/nature-kit',
  },
  {
    name: 'alien',
    // "Alien" by Quaternius (animated).
    source: { kind: 'url', url: 'https://static.poly.pizza/0bb74be9-e9d1-4321-aedb-a9eccecb04a1.glb' },
    sourceUrl: 'https://poly.pizza/m/sUTLXji0aL',
    keepAnimations: ['Walk', 'Idle', 'Jump', 'Dance'],
  },
  {
    name: 'bird',
    // "Bird" by Quaternius.
    source: { kind: 'url', url: 'https://static.poly.pizza/bc6de37a-fdc5-4ef2-85c6-4a2e7b5db9d5.glb' },
    sourceUrl: 'https://poly.pizza/m/gYYC0gYMnw',
  },
  {
    name: 'shark',
    // "Shark" by Quaternius (animated swim).
    source: { kind: 'url', url: 'https://static.poly.pizza/d2d374ea-eb1d-4659-8cc7-816a83b82470.glb' },
    sourceUrl: 'https://poly.pizza/m/AyHTK3zUSG',
    keepAnimations: ['Swim'],
  },

  // ── Fill to 50 (2026-07-13, with retrieval-lite selection in place). ───────
  // Kenney items ride kits already vetted above; poly.pizza entries were
  // CC0-page-checked + size-probed like every batch before. Rejected
  // over-budget: Penguin ~154 KB, Panda ~177 KB, Bunny ~154 KB, Turtle
  // ~128 KB (all mesh-heavy characters).
  { name: 'hero', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/character-oobi.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'heart', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/heart.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'gem', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/jewel.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'bomb', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/bomb.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'spring', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/spring.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'flag', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/flag.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'mushroom', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/mushrooms.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'barrel', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/barrel.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'crate', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/crate.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'taxi', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/taxi.glb' }, sourceUrl: 'https://kenney.nl/assets/car-kit' },
  { name: 'ambulance', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/ambulance.glb' }, sourceUrl: 'https://kenney.nl/assets/car-kit' },
  { name: 'tractor', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/tractor.glb' }, sourceUrl: 'https://kenney.nl/assets/car-kit' },
  { name: 'catapult', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/siege-catapult.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },
  { name: 'bridge', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/bridge-straight.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },
  { name: 'burger', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/burger.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'ice_cream', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/ice-cream.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'donut', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/donut-sprinkles.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'apple', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/apple.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  {
    name: 'chicken',
    // "Chicken" by Quaternius (animated).
    source: { kind: 'url', url: 'https://static.poly.pizza/a0001762-9352-48c3-9abd-be91e42db114.glb' },
    sourceUrl: 'https://poly.pizza/m/ineV9pU5VL',
    keepAnimations: ['Walk', 'Idle', 'Jump'],
  },
  {
    name: 'bat',
    // "Bat" by Quaternius (animated flying).
    source: { kind: 'url', url: 'https://static.poly.pizza/4ae13ae9-c257-41ed-86b5-1b4760924ebc.glb' },
    sourceUrl: 'https://poly.pizza/m/hNO9XvjlKa',
    keepAnimations: ['Flying', 'Attack'],
  },
  {
    name: 'dolphin',
    // "Dolphin" by Quaternius (animated swim).
    source: { kind: 'url', url: 'https://static.poly.pizza/fcea284f-cafc-4be1-a701-2a0fd811ad5c.glb' },
    sourceUrl: 'https://poly.pizza/m/3LzFgI3GLO',
    keepAnimations: ['Swim'],
  },
  {
    name: 'bee',
    // "Armabee" by Quaternius (animated flying).
    source: { kind: 'url', url: 'https://static.poly.pizza/de63aaf6-9170-47f7-933d-439af68826a6.glb' },
    sourceUrl: 'https://poly.pizza/m/42djT5zJnx',
    keepAnimations: ['Flying', 'Idle'],
  },
  {
    name: 'sword',
    // "Sword" by Quaternius.
    source: { kind: 'url', url: 'https://static.poly.pizza/65837148-8c3c-42d5-9ce7-c55f9295cc7e.glb' },
    sourceUrl: 'https://poly.pizza/m/9lLmH8Et4K',
  },

  // ── Fill to 100 (2026-07-14, owner request): 50 more. All Kenney entries ride
  // kits already vetted above (car-kit, castle-kit, platformer-kit, food-kit,
  // nature-kit — zips already cached, zero new downloads needed for those).
  // Two new kits added this batch: city-kit-commercial/city-kit-suburban
  // (CC0-checked via kenney.nl page, per §4.4) for city models, and racing-kit
  // (CC0-checked via kenney.nl page) for race-track pieces — both fetched at
  // curation time 2026-07-14. Dragons are poly.pizza/Quaternius, same pattern
  // as every other creature above; CC0 confirmed on both model pages.
  // Every entry below was size-probed through this exact transform before
  // being pinned (dry run, no --upload) — see BUG-FIX-LOG equivalent note in
  // this repo's asset-curation history.
  { name: 'garbage_truck', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/garbage-truck.glb' }, sourceUrl: 'https://kenney.nl/assets/car-kit' },
  { name: 'pickup_truck', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/truck.glb' }, sourceUrl: 'https://kenney.nl/assets/car-kit' },
  { name: 'gokart', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: 'Models/GLB format/kart-oobi.glb' }, sourceUrl: 'https://kenney.nl/assets/car-kit' },

  { name: 'ballista', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/siege-ballista.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },
  { name: 'trebuchet', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/siege-trebuchet.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },
  { name: 'battering_ram', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/siege-ram.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },
  { name: 'castle_gate', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/gate.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },
  { name: 'drawbridge', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/bridge-draw.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },
  { name: 'siege_tower', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/siege-tower.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },
  { name: 'castle_door', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/castle-kit/a395102d20-1711543616/kenney_castle-kit.zip', innerPath: 'Models/GLB format/door.glb' }, sourceUrl: 'https://kenney.nl/assets/castle-kit' },

  { name: 'lock', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/lock.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'lever', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/lever.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'saw', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/saw.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'signpost', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/sign.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },
  { name: 'ladder', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/platformer-kit/1585cf62b4-1775122253/kenney_platformer-kit.zip', innerPath: 'Models/GLB format/ladder.glb' }, sourceUrl: 'https://kenney.nl/assets/platformer-kit' },

  { name: 'pizza', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/pizza.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'hotdog', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/hot-dog.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'banana', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/banana.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'watermelon', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/watermelon.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'cake', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/cake.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'cupcake', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/cupcake.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'taco', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/taco.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'carrot', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/carrot.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'strawberry', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/strawberry.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'sandwich', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/sandwich.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'corn', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/corn.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'sushi', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/maki-salmon.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'egg', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/egg.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'muffin', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/muffin.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },
  { name: 'cherries', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/food-kit/83086fa91c-1719418518/kenney_food-kit.zip', innerPath: 'Models/GLB format/cherries.glb' }, sourceUrl: 'https://kenney.nl/assets/food-kit' },

  { name: 'cactus', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip', innerPath: 'Models/GLTF format/cactus_tall.glb' }, sourceUrl: 'https://kenney.nl/assets/nature-kit' },
  { name: 'campfire', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip', innerPath: 'Models/GLTF format/campfire_logs.glb' }, sourceUrl: 'https://kenney.nl/assets/nature-kit' },
  { name: 'canoe', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip', innerPath: 'Models/GLTF format/canoe.glb' }, sourceUrl: 'https://kenney.nl/assets/nature-kit' },
  { name: 'tent', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip', innerPath: 'Models/GLTF format/tent_smallClosed.glb' }, sourceUrl: 'https://kenney.nl/assets/nature-kit' },
  { name: 'palm_tree', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip', innerPath: 'Models/GLTF format/tree_palm.glb' }, sourceUrl: 'https://kenney.nl/assets/nature-kit' },
  { name: 'statue', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip', innerPath: 'Models/GLTF format/statue_head.glb' }, sourceUrl: 'https://kenney.nl/assets/nature-kit' },
  { name: 'toadstool', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip', innerPath: 'Models/GLTF format/mushroom_red.glb' }, sourceUrl: 'https://kenney.nl/assets/nature-kit' },

  // City models (new kits this batch — CC0 confirmed on the kenney.nl asset page).
  { name: 'office_building', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-commercial/a742d900eb-1753115042/kenney_city-kit-commercial_2.1.zip', innerPath: 'Models/GLB format/building-e.glb' }, sourceUrl: 'https://kenney.nl/assets/city-kit-commercial' },
  { name: 'shop', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-commercial/a742d900eb-1753115042/kenney_city-kit-commercial_2.1.zip', innerPath: 'Models/GLB format/low-detail-building-a.glb' }, sourceUrl: 'https://kenney.nl/assets/city-kit-commercial' },
  { name: 'apartment', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip', innerPath: 'Models/GLB format/building-type-c.glb' }, sourceUrl: 'https://kenney.nl/assets/city-kit-suburban' },
  { name: 'driveway', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip', innerPath: 'Models/GLB format/driveway-long.glb' }, sourceUrl: 'https://kenney.nl/assets/city-kit-suburban' },
  { name: 'planter', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip', innerPath: 'Models/GLB format/planter.glb' }, sourceUrl: 'https://kenney.nl/assets/city-kit-suburban' },

  // Race track pieces (new kit this batch — racing-kit, CC0 confirmed on the kenney.nl page).
  { name: 'race_track_straight', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/roadStraight.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },
  { name: 'race_track_curve', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/roadCurved.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },
  { name: 'finish_line', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/roadStart.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },
  { name: 'checkered_flag', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/flagCheckers.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },
  { name: 'grandstand', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/grandStand.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },
  { name: 'pit_garage', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/pitsGarage.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },

  // Dragons (poly.pizza / Quaternius — CC0 confirmed on both model pages, 2026-07-14).
  {
    name: 'dragon',
    // "Dragon" by Quaternius — fits fully un-trimmed (75 KB, all 5 clips kept).
    source: { kind: 'url', url: 'https://static.poly.pizza/9714f533-5d2d-4cfd-b8f1-c8dfff64a672.glb' },
    sourceUrl: 'https://poly.pizza/m/VBvzjFIYws',
  },
  {
    name: 'dragon_evolved',
    // "Dragon" by Quaternius (poly.pizza/m/3rUm1cN3yp — a second, distinct
    // listing from the same author, smaller mesh than /m/LlwD0QNUPj "Dragon
    // Evolved", which was REJECTED: 119 KB un-simplified, and simplify()
    // no-ops on this project's skinned/rigged meshes (same class as the
    // Shiba Inu/Husky/horse rejections above) — animation trimming barely
    // moved it either (mesh-dominated, not clip-dominated). This variant
    // fits fully un-simplified at 74 KB with all 8 clips kept.
    source: { kind: 'url', url: 'https://static.poly.pizza/ae5b8510-1fa5-4d53-b943-a4f3b88fb629.glb' },
    sourceUrl: 'https://poly.pizza/m/3rUm1cN3yp',
  },
];

await mkdir(outDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** Stage 1+2 for one model: returns { bytes, sha256, fileName, url }. */
async function prepare(model) {
  // Per-model dir: Kenney GLBs reference an EXTERNAL Textures/colormap.png
  // (sibling folder in the kit) — it must sit next to the GLB so
  // gltf-transform can resolve and EMBED it. Shipping the .glb alone made
  // every Kenney model white (gallery visual pass, 2026-07-12).
  const modelDir = join(cacheDir, model.name);
  await mkdir(modelDir, { recursive: true });
  const rawPath = join(modelDir, 'raw.glb');

  if (model.source.kind === 'kenney-zip') {
    const zipPath = join(cacheDir, model.source.zip.split('/').pop());
    if (!existsSync(zipPath)) {
      console.log(`  ↓ ${model.source.zip}`);
      await download(model.source.zip, zipPath);
    }
    execFileSync('unzip', ['-o', '-j', zipPath, model.source.innerPath, '-d', modelDir], { stdio: 'pipe' });
    await writeFile(rawPath, await readFile(join(modelDir, model.source.innerPath.split('/').pop())));
    const texturesGlob = `${model.source.innerPath.split('/').slice(0, -1).join('/')}/Textures/*`;
    const texturesDir = join(modelDir, 'Textures');
    await mkdir(texturesDir, { recursive: true });
    try {
      execFileSync('unzip', ['-o', '-j', zipPath, texturesGlob, '-d', texturesDir], { stdio: 'pipe' });
    } catch { /* kit without a Textures folder — GLB is self-contained */ }
  } else {
    console.log(`  ↓ ${model.source.url}`);
    await download(model.source.url, rawPath);
  }

  // Meshopt compression + quantization via gltf-transform. Deterministic for
  // a given input+version, so re-runs produce the same hash (append-only
  // safe). Textures pass through byte-identical.
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  // io.read (not readBinary): resolves the external texture from disk; the
  // writeBinary below embeds every resource into the published GLB.
  const doc = await io.read(rawPath);
  const clipNames = doc.getRoot().listAnimations().map((a) => a.getName());
  if (clipNames.length) console.log(`  clips: ${clipNames.join(', ')}`);
  // keepAnimations: animation clips dominate rigged models — drop the ones a
  // kid's game won't call. Segment-exact match ('Idle' keeps 'Idle' and
  // 'Armature|Velociraptor_Idle' but NOT 'Idle_2' or 'Jump_ToIdle' — bare
  // substring matching kept half the clip set and blew the budget).
  if (model.keepAnimations) {
    const matches = (name, keep) => {
      const leaf = name.split('|').pop();
      return leaf === keep || leaf.endsWith(`_${keep}`);
    };
    for (const anim of doc.getRoot().listAnimations()) {
      if (!model.keepAnimations.some((k) => matches(anim.getName(), k))) anim.dispose();
    }
  }
  // resample drops redundant keyframes; simplifyRatio (optional) decimates
  // unskinned meshes; meshopt 'high' compresses everything.
  const steps = [dedup(), prune(), resample()];
  if (model.simplifyRatio) {
    steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: model.simplifyRatio, error: 0.001 }));
  }
  steps.push(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  await doc.transform(...steps);
  const bytes = Buffer.from(await io.writeBinary(doc));
  if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'glTF') {
    throw new Error(`${model.name}: compressed output is not a GLB (magic bytes)`);
  }
  if (bytes.length > MODEL_BUDGET_BYTES) {
    throw new Error(`${model.name}: ${bytes.length} bytes > model budget ${MODEL_BUDGET_BYTES} (PRD §8) — pick a smaller source or simplify (-si)`);
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileName = `${model.name}.${sha256.slice(0, 6)}.glb`;
  await writeFile(join(outDir, fileName), bytes);
  return { bytes, sha256, fileName, url: `${ASSET_HOST_ORIGIN}/${fileName}` };
}

const prepared = [];
for (const model of MODELS) {
  console.log(`● ${model.name}`);
  const p = await prepare(model);
  prepared.push({ model, ...p });
  console.log(`  ✓ ${p.fileName} (${(p.bytes.length / 1024).toFixed(1)} KB) → .assets-out/models/`);
}

if (!process.argv.includes('--upload')) {
  console.log(`\nDry run (no --upload). Next stages would, per model:`);
  console.log(`  3. PutObject → {S3_PREFIX}sites/assets/{file}  Cache-Control: ${CACHE_CONTROL} (skip-if-exists)`);
  console.log(`  4. GET the public URL and verify sha256 + immutable header`);
  console.log(`  5. write manifest entries + run manifest contract tests`);
  process.exit(0);
}

// ── stage 3+4: upload + public verify (append-only; upload-then-verify) ─────
const { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET } = process.env;
const S3_PREFIX = process.env.S3_PREFIX || 'ariantra/';
if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET) {
  console.error('✗ --upload needs AWS env (run with: node --env-file=../Ariantra-Platform/.env scripts/vendor-models.mjs --upload)');
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
      ContentType: 'model/gltf-binary', CacheControl: CACHE_CONTROL,
    }));
    console.log(`✓ uploaded s3://${S3_BUCKET}/${key}`);
  }

  const res = await fetch(p.url);
  if (!res.ok) {
    console.error(`✗ ${p.url} → HTTP ${res.status} — NOT adding a manifest entry (upload-then-verify)`);
    process.exit(1);
  }
  const served = Buffer.from(await res.arrayBuffer());
  const servedSha = createHash('sha256').update(served).digest('hex');
  if (servedSha !== p.sha256) {
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
    name: p.model.name,
    type: 'model',
    url: p.url,
    bytes: p.bytes.length,
    license: 'CC0',
    sourceUrl: p.model.sourceUrl,
    sha256: p.sha256,
  };
  const existing = manifest.assets.findIndex((a) => a.name === p.model.name);
  if (existing >= 0) manifest.assets[existing] = entryJson;
  else manifest.assets.push(entryJson);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

execFileSync('npx', ['vitest', 'run', 'src/lib/assets/'], { cwd: repo, stdio: 'inherit' });
console.log(`✓ manifest entries written and contract tests green — commit src/lib/assets/manifest.json`);
