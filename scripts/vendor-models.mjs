#!/usr/bin/env node
/**
 * The CC0 model pipeline (PRD-3D-GAMES-AND-ASSETS §4): download → compress →
 * hash-name → publish to the immutable asset host → verify → manifest.
 * Sibling of vendor-three.mjs; runs on the dev Mac at curation time, never on
 * the box (§6 ①).
 *
 * Sources are pinned per model below with the license-proof URL (the Kenney
 * asset page or the poly.pizza model page whose license section shows the
 * license) — `sourceUrl` in the manifest IS the proof trail (§4.4). CC0 by
 * default; since 2026-08-06 (owner decision, motorcycle batch) a model may
 * carry `license: 'CC-BY-3.0'` + `author:` — the manifest validators then
 * REQUIRE the author, and inject.ts bakes the credit chip into every game
 * that uses it. sfx/music stay CC0-only.
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
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, simplify, meshopt, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { assertLongAxisZ, yRotation } from './lib/orientation.mjs';
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
const MODEL_BUDGET_BYTES = 150_000; // keep in sync with BUDGET_BYTES.model (manifest.ts) — raised 100 K → 150 K 2026-07-29, see the note there
const CACHE_CONTROL = 'public, max-age=31536000, immutable'; // hash naming makes this safe (BUG_LOG #6: always explicit)

// ── the curated set (Decision H: car, dino, tree, coin, rocket first) ────────
// kind 'kenney-zip': the kit zip is the download, innerPath the GLB inside it;
// sourceUrl = the kit page (its License.txt says CC0, kept in the zip).
// kind 'url': a direct CC0 GLB; sourceUrl = the poly.pizza model page whose
// license section shows CC0 (checked at curation time, 2026-07-12).
const CITY_ROAD_AXIS = {
  road_straight: 'x',
  road_ramp: 'x',
  road_crossing: 'x',
  road_curve: 'none',
  road_intersection: 'none',
  road_roundabout: 'none',
};

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
    // "Dog" by Quaternius (animated) — REPLACED 2026-08-05 (TECH_DEBT #87
    // follow-up): the original "Pug" source only shipped Idle/Jump, no
    // locomotion clip at all, so a dog could never visibly run/walk no
    // matter what game code called it. This source is from the same
    // AnimalArmature-rigged Quaternius pack as `cat`/`dino`/`chicken` and
    // carries real Walk/Run clips (verified against the downloaded GLB
    // before pinning here) plus a full leg rig (FrontLeg/BackLeg .L/.R).
    source: { kind: 'url', url: 'https://static.poly.pizza/de55d76a-f578-4979-97ff-2a62edac32f3.glb' },
    sourceUrl: 'https://poly.pizza/m/2kUk0QqpCg',
    keepAnimations: ['Idle', 'Walk', 'Run'],
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

  // ── City batch 2 (2026-07-24). The city genre was the library's weakest —
  // 7 models built from 81 already sitting in the cached zips. Named from
  // renders of the actual GLBs (the kits ship letter names only: building-a,
  // building-type-a…). The kits' `low-detail-*` files are LOD duplicates of
  // the same buildings, deliberately skipped.
  ...[
    // Commercial — offices, blocks, towers.
    ['office_small', 'building-a'], ['office_wide', 'building-e'], ['office_block', 'building-f'],
    ['flats', 'building-i'], ['garden_apartment', 'building-j'], ['long_office', 'building-k'],
    ['narrow_tower', 'building-m'], ['mall', 'building-n'],
    ['glass_tower', 'building-skyscraper-a'], ['antenna_tower', 'building-skyscraper-c'],
    ['white_tower', 'building-skyscraper-e'],
    // Shopfront details.
    ['awning', 'detail-awning'], ['parasol', 'detail-parasol-a'],
  ].map(([name, file]) => ({
    name,
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-commercial/a742d900eb-1753115042/kenney_city-kit-commercial_2.1.zip', innerPath: `Models/GLB format/${file}.glb` },
    sourceUrl: 'https://kenney.nl/assets/city-kit-commercial',
  })),
  ...[
    // Suburban — houses and street furniture.
    ['family_house', 'building-type-f'], ['bungalow', 'building-type-h'], ['cottage', 'building-type-j'],
    ['town_house', 'building-type-k'], ['dark_house', 'building-type-l'], ['porch_house', 'building-type-n'],
    ['modern_house', 'building-type-p'], ['modern_villa', 'building-type-q'],
    ['stilt_house', 'building-type-r'], ['garage_house', 'building-type-u'],
    ['fence', 'fence'], ['low_fence', 'fence-low'],
    ['garden_path', 'path-long'], ['stone_path', 'path-stones-long'],
    ['short_driveway', 'driveway-short'], ['small_tree', 'tree-small'],
  ].map(([name, file]) => ({
    name,
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-suburban/2c871b7af2-1745479373/kenney_city-kit-suburban_20.zip', innerPath: `Models/GLB format/${file}.glb` },
    sourceUrl: 'https://kenney.nl/assets/city-kit-suburban',
  })),

  // ── Vehicles batch 2 (2026-07-24). car-kit ships semantic filenames, so no
  // render pass was needed. Note the existing `car` is race.glb and
  // `pickup_truck` is truck.glb — hence `sedan`/`flatbed_truck` below rather
  // than re-taking those names. debris-* (crash parts) and wheel-* are skipped:
  // too niche for a kids' catalog and they'd crowd the prompt.
  ...[
    ['sedan', 'sedan'], ['sports_car', 'sedan-sports'], ['hatchback', 'hatchback-sports'],
    ['suv', 'suv'], ['luxury_suv', 'suv-luxury'], ['van', 'van'],
    ['delivery_van', 'delivery'], ['truck', 'truck-flat'], ['digger', 'tractor-shovel'],
    ['future_car', 'race-future'], ['race_kart', 'kart-oodi'], ['traffic_cone', 'cone'],
  ].map(([name, file]) => ({
    name,
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip', innerPath: `Models/GLB format/${file}.glb` },
    sourceUrl: 'https://kenney.nl/assets/car-kit',
  })),

  // Race track pieces (new kit this batch — racing-kit, CC0 confirmed on the kenney.nl page).
  // recenterXZ (2026-08-08, BUG-FIX-LOG fragmented race tracks): the racing kit
  // ships arbitrary origins — race_track_straight is a perfect 1 × 1 m tile
  // whose origin sat 1.15 m off in Z, and the curve 1.65 m off. Its SIZE was
  // never wrong, so no amount of scale normalization would have helped: a game
  // stepping the correct 1 m still scattered the geometry. Bake the offset out
  // so origin == footprint centre and `i * modelSize(n).z` tiles edge-to-edge.
  { name: 'race_track_straight', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/roadStraight.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit', recenterXZ: true , pathAxis: 'z' },
  { name: 'race_track_curve', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/roadCurved.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit', recenterXZ: true , pathAxis: 'none' },
  // Real 90-degree CORNERS (2026-08-08, BUG-FIX-LOG "poorly formed race track").
  // These were never vendored, which is the whole bug: `race_track_curve` is
  // Kenney's roadCurved.glb — a CHICANE (enters -Z, leaves +Z shifted 0.5 m
  // sideways, hence its 1.5 x 2 footprint), and the model was dutifully trying
  // to build loops out of a lane-shift because the name said "curve". Both
  // corners below are square and on the kit's 1 m module, so they tile against
  // race_track_straight with no rescaling and no arc distortion.
  { name: 'race_track_corner', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/roadCornerSmall.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit', recenterXZ: true, pathAxis: 'none' },
  { name: 'race_track_corner_wide', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/roadCornerLarge.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit', recenterXZ: true, pathAxis: 'none' },
  { name: 'finish_line', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/roadStart.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit', recenterXZ: true, pathAxis: 'z' },
  { name: 'checkered_flag', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/flagCheckers.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },
  { name: 'grandstand', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/grandStand.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },
  { name: 'pit_garage', source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/racing-kit/933b8fd9fd-1677580949/kenney_racing-kit.zip', innerPath: 'Models/GLTF format/pitsGarage.glb' }, sourceUrl: 'https://kenney.nl/assets/racing-kit' },

  // ── People (2026-07-19, owner request: humans who cheer/walk/run/sit in
  // stadiums "and do all types of work"). Kenney Blocky Characters 2.0 —
  // CC0 per the License.txt in the kit zip and the kenney.nl asset page.
  // The ONLY humanoid source that fits the 100 KB budget: every Quaternius
  // human probed 127–154 KB even clip-trimmed + hard-quantized (skinned
  // mesh ⇒ simplify() no-ops, same class as the Shiba Inu/horse rejections),
  // while these land ~55 KB WITH the full crowd clip set. All 6 share one
  // rig and the same 27 source clips; keepAnimations trims the weapon
  // (holding-*-shoot, attack-*) and chairless wheelchair-* clips a kids'
  // catalog shouldn't teach. Clip names are exact (dash-separated) matches.
  // Names must stay in lockstep with PEOPLE_MODELS in
  // src/lib/assets/model-select.ts (people genre + people-clips prompt line).
  // Batch 2 (2026-07-24): the other 12 of the kit's 18. Same zip (already
  // pinned + cached), same rig, same clip set — ~63 KB each, so this is the
  // cheapest variety in the library. Identified from the kit's Previews/*.png;
  // Overview.html carries no semantic names, only letters a–r, so these names
  // are OUR reading of the art. Named for what they visibly ARE:
  //   - NO 'boy'/'child' here. Every one of the 18 shares ONE adult body, so a
  //     child would be a lie the model acts on ("make the boy smaller than the
  //     man" would silently do nothing). Real child proportions need the
  //     160 KB budget + Quaternius Teen — tracked separately.
  //   - The kit is heavily male-presenting: only character-n reads female.
  //     This batch buys variety of ROLE, not of age or gender.
  ...[
    ['man', 'character-b'], ['woman', 'character-f'], ['girl', 'character-e'],
    ['scientist', 'character-i'], ['police_officer', 'character-j'], ['pirate', 'character-p'],
    ['grandpa', 'character-a'], ['gamer', 'character-c'], ['mascot', 'character-d'],
    ['mech', 'character-g'], ['purple_mech', 'character-h'], ['plumber', 'character-k'],
    ['zombie', 'character-l'], ['explorer', 'character-m'], ['kimono_woman', 'character-n'],
    ['orc', 'character-o'], ['businessman', 'character-q'], ['ninja', 'character-r'],
  ].map(([name, file]) => ({
    name,
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/blocky-characters/8369c0cf30-1749547469/kenney_blocky-characters_20.zip', innerPath: `Models/GLB format/${file}.glb` },
    sourceUrl: 'https://kenney.nl/assets/blocky-characters',
    keepAnimations: ['static', 'idle', 'walk', 'sprint', 'sit', 'drive', 'die', 'pick-up', 'emote-yes', 'emote-no', 'interact-right', 'interact-left'],
  })),

  // ── Sports batch (2026-07-26, docs/2026-07-26_PRD_SportsAssets.md). No CC0
  // third-party soccer or spinning-top models exist (poly.pizza sports = the
  // CC-BY Google-Poly archive, license-scanned 2026-07-26; Kenney and
  // Quaternius publish no 3D sports kits; Beyblade meshes are branded and
  // fail §4.2). So these are FIRST-PARTY: kind 'local' copies from
  // assets-src/models/<name>/ (regenerate with
  // scripts/author-first-party-models.mjs). sourceUrl for the four authored
  // models is the in-repo CC0 dedication; the two footballers are re-textured
  // Kenney character-b (mesh/rig untouched → same clip set as the other
  // blocky characters), so their proof trail is the kenney.nl page.
  { name: 'soccer_ball', source: { kind: 'local', dir: 'assets-src/models/soccer_ball' }, sourceUrl: 'https://github.com/N-Ashok/KidGemini/blob/main/assets-src/LICENSE.md' },
  { name: 'soccer_goal', source: { kind: 'local', dir: 'assets-src/models/soccer_goal' }, sourceUrl: 'https://github.com/N-Ashok/KidGemini/blob/main/assets-src/LICENSE.md' },
  { name: 'battle_top', source: { kind: 'local', dir: 'assets-src/models/battle_top' }, sourceUrl: 'https://github.com/N-Ashok/KidGemini/blob/main/assets-src/LICENSE.md' },
  { name: 'blade_top', source: { kind: 'local', dir: 'assets-src/models/blade_top' }, sourceUrl: 'https://github.com/N-Ashok/KidGemini/blob/main/assets-src/LICENSE.md' },
  ...[['footballer'], ['footballer_blue']].map(([name]) => ({
    name,
    source: { kind: 'local', dir: `assets-src/models/${name}` },
    sourceUrl: 'https://kenney.nl/assets/blocky-characters',
    // Same trim as the other blocky characters PLUS the two kick clips: the
    // blanket attack-* exclusion targets weapon moves, but for a footballer
    // the kick IS the sport (a /kick/i clip search finds them).
    keepAnimations: ['static', 'idle', 'walk', 'sprint', 'sit', 'drive', 'die', 'pick-up', 'emote-yes', 'emote-no', 'interact-right', 'interact-left', 'attack-kick-right', 'attack-kick-left'],
  })),

  // ── Military batch (2026-07-29, docs/2026-07-29_PRD_MilitaryAssets.md).
  // Owner ask: "more tanks and military 3D items". poly.pizza license-scanned
  // 2026-07-29 across 40 military search terms (scripted: license section =
  // publicdomain/zero); every entry below is CC0 and thumbnail-reviewed before
  // pinning. SCOPE DECISION (owner, same session): VEHICLES + FORTIFICATIONS
  // ONLY — no soldier characters and no hand-held weapons. The CC0 pool does
  // contain rifle/bazooka/grenade-launcher/sniper props and Quaternius'
  // "Character Soldier"/"SWAT" humanoids; they are deliberately NOT vendored.
  // This keeps the batch inside the register safety.config.ts already blesses
  // ("cartoon video-game action ... tank games with bloodless pop/vanish
  // enemies is NOT violence") and beside the existing fantasy-siege set
  // (catapult, trebuchet, ballista, battering_ram) rather than adding modern
  // firearms to a 6-12yo catalog. Re-read that decision before extending.
  //
  // Rejected after the thumbnail pass, so nobody re-adds them: /m/j59k7ctnZM
  // ("Tank" — actually propane cylinders), /m/Jzj8dz4Cj0 ("Short Cannon" —
  // actually a shotgun), the six Quaternius "Barracks" (fantasy-town temples,
  // not military), /m/44e04449 + /m/af9ebe34 watch towers (medieval stone —
  // the library already has `tower`). No CC0 jeep, humvee, APC, fighter jet,
  // hangar or army tent exists anywhere in the pool; ground cover comes from
  // the armored vehicles, air from the existing helicopter/rocket/spaceship.
  ...[
    // Four tanks so a battle has visibly distinct SIDES (a kid saying "my tank
    // vs the enemy tank" needs two meshes, not one recolored at runtime).
    // ⚠️ KNOWN off-convention (2026-08-06 orientation audit): tank_desert and
    // tank_rusty are authored X-long (sideways per the vehicle facing
    // convention). Deliberately NOT rotated and NOT assertLongAxis-flagged:
    // they shipped 2026-07-29 and existing war-game chats may compensate in
    // code — silently flipping the asset would break them the same way the
    // sideways bike broke Sky Patrol. Rotate + flag WITH a blast-radius check
    // at the next military-asset touch (TECH_DEBT #91).
    ['tank', 'cW3zvvkMOM', '58c387b2-636f-49dc-a900-13b0852717d6'],          // olive, classic
    ['tank_desert', 'FA5daiyZQq', '4a40c214-87f9-4cdb-bc72-003c96f49f76'],   // sand
    ['tank_toy', 'Dc4k4CooN3', '2568b2cb-58e0-49d8-9d3b-6f208ad281c7'],      // yellow cartoon
    // Lands at 150,348 B welded — 348 B over the line. It is flat-shaded so
    // simplify() barely bites (ratio 0.25 and 0.6 give the same output), but
    // the ~1 KB it does shave is enough. Not a budget-line judgement call:
    // 149.4 KB is under 150,000 B, full stop.
    ['tank_rusty', 'uYHpj7lz1J', 'c0135fb4-3307-4c0f-a439-86ceafedc4c7', 0.6], // dark red, reads "enemy"
    // The one model here simplify() actually bites on (it is smooth-shaded, so
    // weld finds edges to collapse): 153.3 KB raw → 126.5 KB at ratio 0.5.
    ['armored_truck', 'VvX8nmoCN5', '55c7dea2-0251-457b-b8e3-8e9eb07aa4cc', 0.5],
    ['armored_pickup', 'RUwMItmU4B', 'cc992b7f-3e7f-474e-8e45-f80b72010669'],
    ['turret', 'hThPXDCbwl', '730a54af-3785-4d23-8efc-1560ed61e0d3'],        // twin-gun dome
    ['turret_cannon', 'mNJ6poH7Cp', '5669a490-372e-41a6-ac5f-b8ca5b69e4a5'], // single big barrel
    ['cannon', 'qIAvoaawib', '8054a1bd-2117-41cf-be71-31b6cb2d2ef2'],
    ['sandbags', 'LW3jwpPfiN', '96654c1e-dbc8-4bbc-a1c0-0dfacd8e9d93'],
    ['sandbags_small', 'iHyRewQQcN', '00e71997-0e9f-4083-9507-3935639996c7'],
    ['bunker', 'UyH95ZAeJ2', 'f8e09790-8770-4cad-91f0-edefd14eb34f'],
    ['watchtower', 'sbaM8I229r', '5d56ff95-db7a-43d6-997f-e9eea3f13f53'],
    ['radar', 'V7XQDxF8JC', 'ac218d89-a903-4cc1-aa32-bd70262cda76'],
    ['chain_fence', 'qWKhREFj7H', '94d06743-b682-4a86-9bba-499c351282b7'],   // base perimeter
  ].map(([name, slug, uuid, simplifyRatio]) => ({
    name,
    source: { kind: 'url', url: `https://static.poly.pizza/${uuid}.glb` },
    sourceUrl: `https://poly.pizza/m/${slug}`,
    ...(simplifyRatio ? { simplifyRatio } : {}),
    // keepAnimations: [] drops EVERY clip. The Quaternius tanks ship a rigged
    // TankArmature with Forward/Backwards/TurningLeft/TurningRight drive clips
    // that cost ~40 KB and blow the 100 KB budget (tank probed at 138,912 B
    // with them, 2026-07-29) — while a kid's game drives a tank by moving
    // position/rotation, never by playing a clip. Dropping them also lets
    // prune() remove the now-unused Skin, which is what puts these under
    // budget AND re-enables simplify() (it no-ops on skinned meshes — the
    // documented Shiba Inu/horse rejection class). Nothing in this batch is a
    // character, so no clip promise is broken.
    keepAnimations: [],
  })),
  // Kenney's barricade (its own kit page carries the CC0 License.txt); taken as
  // a direct GLB rather than a kit zip because poly.pizza already hosts it.
  { name: 'barricade', source: { kind: 'url', url: 'https://static.poly.pizza/23074192-32eb-4870-9cb3-c95648e4ea62.glb' }, sourceUrl: 'https://poly.pizza/m/3UZHUnkzTu' },

  // ── Military batch 2: soldiers + weapons (2026-07-29, same PRD §3e).
  // OWNER DECISION, same session, REVERSING the batch-1 scope: "let there be
  // soldiers, hand held weapons and grenade launchers — it is all part of kids
  // games these days." So the humanoids and the weapon props that batch 1
  // deliberately skipped are now vendored. This needs NO safety-config change:
  // safety.config.ts already reads "fictional weapons inside a game a child is
  // making/playing are NOT dangerous acts" and "cartoon video-game action
  // (space shooters, sword adventures, tank games with bloodless 'pop/vanish'
  // enemies) is NOT violence" — the batch lands inside the existing policy
  // rather than moving it. All CC0, all thumbnail- + render-reviewed.
  ...[
    ['rifle', 'neEjwx9bBJ', 'da83f4f9-7a4e-4739-9033-79d688aa3b5e'],
    ['assault_rifle', 'Bgvuu4CUMV', '9a0e478c-de82-4773-9b70-a0219bb0057c'],
    ['sniper_rifle', 'i65hEldsw6', '2def4aa0-1f3a-40dd-aa92-0661ce39ae50'],
    ['shotgun', 'DcNE0HVdW8', '032e6589-3188-41bc-b92b-e25528344275'],
    ['pistol', '1vBdqOfUNd', '01cd757e-2fbc-4a2d-a96f-505a6fbd6924'],
    ['revolver', '9C26wSpMS0', '9e728565-67a3-44db-9567-982320abff09'],
    ['submachine_gun', '7ehatxr7FY', 'fb8ae707-d5b9-4eb8-ab8c-1c78d3c1f710'],
    ['rocket_launcher', 'GCqUvqleqN', '4b445cbf-38b6-43f3-afd6-32d88e8f074b'],
    ['grenade_launcher', 'ZKvWhvu4tV', 'bcbc44eb-76f2-4282-8817-7c81fa0d5eb4'],
    ['grenade', 'xnuUzBTsUg', 'd3a086a7-e545-4cc0-a279-7cd2da2020b8'],
    ['landmine', 'PtqkseZo9O', '81a6a677-60f1-4e24-ae34-ac4e78dcb0e0'],
    ['flare_gun', '44H9OBUqTC', '9ec52cda-c918-43f0-b7af-354e7fe96c37'],
    ['laser_gun', 'Nl8qWErOw2', '8a1950c4-4bda-46ae-a9e3-baacddca5d59'],
    ['space_rifle', 'j40c8VDdAQ', '78846e47-3be2-48f2-a7ce-6b50c09358bb'],
    ['space_pistol', 'TuHM3CURcC', 'd65f40a0-25a1-4f74-b657-2dbe5e621b09'],
    ['bullets', 'bTEYFxKHF9', 'd77c65f0-1e08-4085-a31d-2fed73d51315'],
    ['shield', 'srN1KGAO7f', '60cc7b8e-0589-4f4b-a354-f6fef73a44bd'],
  ].map(([name, slug, uuid]) => ({
    name,
    source: { kind: 'url', url: `https://static.poly.pizza/${uuid}.glb` },
    sourceUrl: `https://poly.pizza/m/${slug}`,
    keepAnimations: [], // static props — a game aims them by transform
  })),
  // The bazooka is CreativeTrio's (CC0 per its model page), the only one that
  // reads as the classic shoulder tube rather than a sci-fi launcher.
  { name: 'bazooka', source: { kind: 'url', url: 'https://static.poly.pizza/613e3b1b-d07c-496b-94a1-7c85b507bac4.glb' }, sourceUrl: 'https://poly.pizza/m/eJNzLpBsEt', keepAnimations: [] },

  // Rejected on the render pass: riot_shield (CreativeTrio Police Shield) —
  // it is a flat, near-black plane with no readable shield silhouette in 3D.
  // Rejected over budget, recorded so nobody re-adds them: ammo_box
  // (Pichuliru Ammo Can, 192.7 KB — `bullets` covers the pickup anyway);
  // swat (388.2 KB even clip-trimmed — only 4 body meshes, but very dense,
  // and skinned meshes are simplify()'s no-op); enemy_soldier (186.1 KB with
  // the weapon rack dropped AND cut to 4 clips — mesh-dominated). The second
  // "side" a battle needs is covered by hazmat, which reads as a visibly
  // different character and fits.
  //
  // Soldier characters. Quaternius humanoids are a DIFFERENT rig from the
  // Kenney blocky people (different clip names), so they get their own rig id
  // in asset-taxonomy.ts — the shared-clips prompt line must never claim a
  // soldier answers to the Kenney clip names. keepAnimations is set from the
  // real clip list after the first dry run (it prints them).
  ...[
    ['soldier', 'PpLF4rt4ah', '1083c1d3-d1d4-4682-adf6-bc516d06ac84'],
    ['hazmat', 'z3TSQYx1Kn', '484450a4-b76c-4e76-95d2-352337bb41e8'],
  ].map(([name, slug, uuid]) => ({
    name,
    source: { kind: 'url', url: `https://static.poly.pizza/${uuid}.glb` },
    sourceUrl: `https://poly.pizza/m/${slug}`,
    // Untrimmed these are 337–454 KB (clip-dominated: 14–20 clips each incl.
    // several near-duplicate idles). This is the set a kid's game actually
    // calls, and it is IDENTICAL across all four so the shared-rig clip
    // promise in the prompt holds. Names are segment-exact: 'Run_Gun' and
    // 'Idle_Shoot' must be listed in full ('Run' alone does not match them).
    keepAnimations: ['Idle', 'Walk', 'Run', 'Run_Gun', 'Idle_Shoot', 'Death', 'Jump', 'Wave'],
    // Strip the bundled weapon rack — see dropMeshes in prepare(). Anchored on
    // the exact mesh names Quaternius ships so a body part can never match.
    dropMeshes: /^(Sniper(_2)?|SMG|AK|RocketLauncher|GrenadeLauncher|ShortCannon|Shotgun|Revolver(_Small)?|Pistol|Shovel|Knife_[12])$/,
  })),

  // ── Cricket batch (2026-07-29, docs/2026-07-29_PRD_CricketAssets.md).
  // FIRST-PARTY, and not by preference: a poly.pizza license sweep (14 cricket
  // terms, 2026-07-29) found ZERO CC0 cricket assets, and only two CC-BY bats
  // at any license — no ball, no stumps, no player anywhere. So unlike the
  // military batch there was simply nothing to download; relaxing the CC0
  // policy would not have helped either. Built by
  // scripts/author-first-party-models.mjs and dedicated CC0 (assets-src/LICENSE.md).
  // The CC0 baseball bats were deliberately NOT reused: a round bat reads as
  // the wrong sport instantly — the flat blade IS the cricket bat.
  ...[
    ['cricket_bat'], ['cricket_ball'], ['wicket'], ['cricket_pitch'], ['sight_screen'],
  ].map(([name]) => ({
    name,
    source: { kind: 'local', dir: `assets-src/models/${name}` },
    sourceUrl: 'https://github.com/N-Ashok/KidGemini/blob/main/assets-src/LICENSE.md',
  })),
  // Kenney character-b re-skinned into cricket whites (mesh + rig untouched →
  // identical clip set to the other blocky people, so the crowd/people prompt
  // line stays true). Proof trail is the kenney.nl page, as for the footballers.
  {
    name: 'cricketer',
    source: { kind: 'local', dir: 'assets-src/models/cricketer' },
    sourceUrl: 'https://kenney.nl/assets/blocky-characters',
    keepAnimations: ['static', 'idle', 'walk', 'sprint', 'sit', 'drive', 'die', 'pick-up', 'emote-yes', 'emote-no', 'interact-right', 'interact-left', 'attack-kick-right', 'attack-kick-left'],
  },
  // The one genuine CC0 find from the sweep that suits a cricket game. Rejected
  // on the render pass: ad_board (/m/8G0qJ84VDS) — a standing A-frame easel,
  // 4.2 x 5.5 m and taller than it is wide, nothing like a boundary hoarding.
  { name: 'trophy', source: { kind: 'url', url: 'https://static.poly.pizza/b56b0827-c9f6-46e6-9a5d-160225686ee7.glb' }, sourceUrl: 'https://poly.pizza/m/fLy8KmmD1t', keepAnimations: [] },

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

  // ── Indian games batch (2026-07-30, docs/2026-07-30_PRD_IndianGamesAssets.md).
  // Owner ask: games popular with Indian kids 7-14 — kabaddi, carrom, kho-kho,
  // badminton, ludo, marbles (cricket excluded — already shipped 2026-07-29).
  // A poly.pizza (CC0-filter)/Kenney/Quaternius sweep (2026-07-30) found ZERO
  // usable third-party models for any of the six — see the PRD §1 for the
  // per-sport rejection notes. FIRST-PARTY, same remedy as soccer/cricket:
  // authored by scripts/author-first-party-models.mjs, dedicated CC0
  // (assets-src/LICENSE.md). kabaddi_player/kho_kho_player are Kenney
  // character-b re-skins (new "kabaddi" kit, retexture-footballer.py) — mesh
  // and rig untouched, so they inherit the full blocky-character clip set.
  ...[
    'kabaddi_mat',
    'carrom_board', 'carrom_striker', 'carrom_coin_white', 'carrom_coin_black', 'carrom_queen',
    'kho_kho_pole', 'kho_kho_lane_field',
    'badminton_racket', 'shuttlecock', 'badminton_net',
    'ludo_board', 'ludo_dice', 'ludo_pawn_red', 'ludo_pawn_green', 'ludo_pawn_yellow', 'ludo_pawn_blue',
    'marble', 'marble_blue', 'marble_green',
  ].map((name) => ({
    name,
    source: { kind: 'local', dir: `assets-src/models/${name}` },
    sourceUrl: 'https://github.com/N-Ashok/KidGemini/blob/main/assets-src/LICENSE.md',
  })),
  // The two re-skinned characters — same proof trail as the footballers/cricketer.
  ...['kabaddi_player', 'kho_kho_player'].map((name) => ({
    name,
    source: { kind: 'local', dir: `assets-src/models/${name}` },
    sourceUrl: 'https://kenney.nl/assets/blocky-characters',
    keepAnimations: ['static', 'idle', 'walk', 'sprint', 'sit', 'drive', 'die', 'pick-up', 'emote-yes', 'emote-no', 'interact-right', 'interact-left'],
  })),

  // ── Motorcycle batch (2026-08-06, docs/2026-08-06_PRD_MotorcycleAssets.md).
  // Owner ask: "at least 10 types of motorcycle meshes". A poly.pizza sweep
  // (30 terms, 2026-08-06) found exactly ONE CC0 motorcycle in the whole pool
  // (below); Kenney has no motorcycle kit, Quaternius' only "bike" is a
  // bicycle, OpenGameArt's one CC0 hit is an untextured .blend/.obj. So:
  // ten FIRST-PARTY bikes (author-first-party-models.mjs, dedicated CC0) +
  // the one CC0 find + five CC-BY 3.0 picks under the NEW attribution wiring
  // (owner decision, same day: "we can provide attribution" — license/author
  // ride the manifest, inject.ts bakes the credit chip into any game using
  // them). Rejected at the thumbnail pass: Suzuki SV650 (/m/1yfyze7uGxS) and
  // Harley "Sportster" (/m/0CZY9yGxi6Y) — branded, §4.2; Speeder Bike
  // (/m/1hTD6Jy384m) — Star Wars fan art; Vespa (/m/blGLclvvdEM) — brand-name
  // design; Google-Poly chopper (/m/cFvmALDjMKw) — duplicates chopper_bike.
  ...[
    'sport_bike', 'race_bike', 'dirt_bike', 'cruiser_bike', 'chopper_bike',
    'police_bike', 'scooter', 'moped', 'delivery_bike', 'mini_bike',
  ].map((name) => ({
    name,
    source: { kind: 'local', dir: `assets-src/models/${name}` },
    sourceUrl: 'https://github.com/N-Ashok/KidGemini/blob/main/assets-src/LICENSE.md',
    assertLongAxis: 'z', // vehicle facing convention (orientation.mjs)
  })),
  // "Cartoony Purple Motorcycle" by AliceCassie — the one CC0 motorcycle.
  // Ships toy-sized (1.04 m long); normalized to read as a ridable bike.
  { name: 'motorcycle', source: { kind: 'url', url: 'https://static.poly.pizza/3ff04d85-dfe6-487c-b01d-5ce92103cf30.glb' }, sourceUrl: 'https://poly.pizza/m/j20srJUjpB', normalizeLongest: 1.9, keepAnimations: [], assertLongAxis: 'z' },
  // CC-BY 3.0 picks — author is REQUIRED (validators) and becomes the in-game
  // credit line; sourceUrl is both proof AND the credit link target.
  // Rejected over budget, recorded so nobody re-adds them (all flat-shaded, so
  // simplify() is the documented no-op — probed 2026-08-06 through the full
  // transform): scrambler_bike /m/bBbozwADWnS 507.8 KB (503.1 KB at ratio
  // 0.25); classic_cruiser /m/5_MTCnqfUTr 1,062 KB (unchanged at ratio 0.12);
  // superbike /m/dse64pqMKAR 1,062 KB-class sibling, same source pipeline.
  // The sport/cruiser reads those two would have added are covered by the
  // first-party sport_bike/race_bike/cruiser_bike above.
  ...[
    // Both ship at absurd author scales (5.2 m and 15.8 m long) — normalized
    // to real-world bike length; the CC0 purple motorcycle is 1.04 m as
    // shipped and stays untouched.
    // street_motorcycle rotateYDeg: -90 (2026-08-06, "the sideways black
    // bike" — BUG-FIX-LOG same date): authored nose-at-+X, the one library
    // vehicle off the facing convention; verified by render before AND after.
    ['military_motorbike', '9SwnIlPjNv', 'b61993ed-4bd4-4439-89c0-933ad42384c7', 'Zsky', 2.3, 0],
    ['street_motorcycle', '0lBe-ApqJs4', '7d230a92-464a-4d1c-874e-712240e2db20', 'jeremy', 2.2, -90],
  ].map(([name, slug, uuid, author, normalizeLongest, rotateYDeg]) => ({
    name,
    source: { kind: 'url', url: `https://static.poly.pizza/${uuid}.glb` },
    sourceUrl: `https://poly.pizza/m/${slug}`,
    license: 'CC-BY-3.0',
    author,
    ...(normalizeLongest ? { normalizeLongest } : {}),
    ...(rotateYDeg ? { rotateYDeg } : {}),
    keepAnimations: [], // static vehicles — a game drives them by transform
    assertLongAxis: 'z', // vehicle facing convention (orientation.mjs)
  })),

  // ── Roads / bridges / jets batch (2026-08-06 later same day,
  // docs/2026-08-06_PRD_RoadsBridgesJets.md). Owner ask: "more roads, long
  // bridges, sky bridges, flying jets". Kenney's city-kit-roads (CC0, checked
  // on the kenney.nl page) finally gives proper per-piece road GLBs — incl.
  // the slant ramps and bridge pillars that let a kid BUILD a flyover/sky
  // bridge. The fixed-wing gap the 2026-07-13 comment documents ("No CC0
  // fixed-wing airplane...") is closed by the CC-BY unlock: the jets below
  // are the license-checked, thumbnail-reviewed picks. Rejected: X-Wing /
  // Arwing / Macross fan art (branded, §4.2); every Google-Poly jet probed or
  // sized ≥ 1 MB raw flat-shaded (the simplify() no-op class); bvbo Metal
  // road_bridge is absent on purpose — see the pathAxis note below.
  // Bridge + Quaternius arch Bridge (unreadable on render); jeremy road tiles
  // + Ian MacGillivray sidewalk road (scene slabs / weaker than the Kenney
  // pieces); KayKit Road Bits + Kenney "Modular Road Kit" poly.pizza listings
  // (whole kits laid out as ONE mesh).
  ...[
    ['road_straight', 'road-straight'], ['road_curve', 'road-curve'],
    ['road_intersection', 'road-intersection'], ['road_crossing', 'road-crossing'],
    ['road_roundabout', 'road-roundabout'], ['road_ramp', 'road-slant'],
    ['road_bridge', 'road-bridge'], ['bridge_pillar', 'bridge-pillar'],
    ['highway_sign', 'sign-highway'],
  // recenterXZ: these tiles ARE already centre-origin (verified 2026-08-08 —
  // road_straight measures -0.5..0.5 on both axes), so the bake is a no-op; it
  // is declared to make the tiling contract explicit and to catch a future
  // kit swap that quietly breaks it. See the race_track_* pair, which was NOT.
  // pathAxis: which way the road RUNS at rest. This kit runs along X — the
  // RACING kit runs along Z, and nothing else exposes the difference (these
  // tiles are 1x1 m squares, so `size` cannot). Before this was published the
  // prompt's "every model faces +Z" made the model rotate every one of these
  // 90 degrees wrong, every time (BUG-FIX-LOG 2026-08-08). Declared, not
  // detected: two independent geometric probes agreed on the straights but
  // DISAGREED on road_bridge, so that one is deliberately left undeclared
  // rather than shipped as a guess. 'none' = a hub/corner with no single run
  // axis, which is a real answer, not a missing one.
  ].map(([name, file]) => ({
    name,
    source: { kind: 'kenney-zip', zip: 'https://kenney.nl/media/pages/assets/city-kit-roads/74288c9459-1741864740/kenney_city-kit-roads.zip', innerPath: `Models/GLB format/${file}.glb` },
    sourceUrl: 'https://kenney.nl/assets/city-kit-roads',
    recenterXZ: true,
    ...(CITY_ROAD_AXIS[name] ? { pathAxis: CITY_ROAD_AXIS[name] } : {}),
  })),
  // Bridges. The two CC0 finds ride as-is; the two CC-BY ones carry authors
  // for the credits chip. normalizeLongest: the suspension bridge is a whole
  // scene (water + shore) shipped 9.4 m long — a car-scale span needs real
  // length; same for the truss/elevated pieces.
  { name: 'wooden_bridge', source: { kind: 'url', url: 'https://static.poly.pizza/e36966b4-e13e-46e8-aa2c-f9b643536d46.glb' }, sourceUrl: 'https://poly.pizza/m/j4KsIuJYnq', keepAnimations: [] },
  { name: 'truss_bridge', source: { kind: 'url', url: 'https://static.poly.pizza/6e5f2f42-6ccb-41cf-9602-89ca933ad5e2.glb' }, sourceUrl: 'https://poly.pizza/m/orI7eNSB38', normalizeLongest: 15, keepAnimations: [] },
  ...[
    ['suspension_bridge', 'a648BwpXx-A', '5cdea6e9-dc24-45e8-8070-d40d0ca1abd1', 'Steren Giannini', 50],
    ['elevated_road', '6x1uuAavZA7', '0289d6b9-a243-4429-b993-8074675790b3', 'Jarlan Perez', 15],
    // Jets & planes — all CC-BY 3.0, all static rigid meshes (a game flies
    // them by transform + its own spun propeller per catalog item 7).
    ['fighter_jet', '6fyLMORhgGK', '19d58465-dafb-4df0-a3b8-b0500bd9ed4b', 'jeremy', 14],
    ['airplane', '9Ev6pklkSYp', '7823e338-576d-49b1-82e1-30fa6cbdb57e', 'jeremy', 36],
    ['small_plane', '7cvx6ex-xfL', '077afae1-24b7-4bac-a31d-53d367002a04', 'Vojtěch Balák', 10],
    ['seaplane', '5xG_QGFWF99', 'e30b0d49-fae4-44e0-9c55-69a8fb33b351', 'Neil M (monkeymad2)', 8],
    ['biplane', 'amIu9ua-L0A', '5cfb30a6-25ab-4f27-94f4-dec75879eac4', 'Jake Blakeley', 7],
    ['private_jet', '1uXmHq-ELhz', 'fcc3a5a9-1154-4f06-88aa-43af532bc974', 'Eik Røgeberg', 13],
  ].map(([name, slug, uuid, author, normalizeLongest]) => ({
    name,
    source: { kind: 'url', url: `https://static.poly.pizza/${uuid}.glb` },
    sourceUrl: `https://poly.pizza/m/${slug}`,
    license: 'CC-BY-3.0',
    author,
    ...(normalizeLongest ? { normalizeLongest } : {}),
    keepAnimations: [],
  })),
];

// --only a,b,c: process just the named models (2026-07-26). A full re-run
// re-prepares every model, so a tool-version drift would re-hash the whole
// library in one accidental sweep; scoping a batch keeps the append-only host
// churn-free. Manifest updates are per-entry, so a partial run is safe.
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null;
if (only) {
  for (const name of only) {
    if (!MODELS.some((m) => m.name === name)) throw new Error(`--only: unknown model "${name}"`);
  }
}
const selectedModels = only ? MODELS.filter((m) => only.has(m.name)) : MODELS;

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
  } else if (model.source.kind === 'local') {
    // First-party source (2026-07-26): raw.glb (+ optional Textures/) authored
    // in-repo by scripts/author-first-party-models.mjs — same dir layout the
    // kenney-zip branch produces, so every later stage is identical.
    const srcDir = join(repo, model.source.dir);
    if (!existsSync(join(srcDir, 'raw.glb'))) {
      throw new Error(`${model.name}: ${model.source.dir}/raw.glb missing — run scripts/author-first-party-models.mjs first`);
    }
    execFileSync('cp', ['-R', `${srcDir}/.`, modelDir], { stdio: 'pipe' });
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
  // dropMeshes: some source files are whole KITS, not one model — the
  // Quaternius soldiers each carry a 12–14 mesh weapon rack (Sniper, SMG, AK,
  // RocketLauncher, Knife…) parented to the hand bones, which is most of their
  // 337–454 KB. We vendor those weapons as their own models, so the rack is
  // pure waste here. Matching is on the mesh name; the now-empty bone nodes are
  // harmless (and prune() clears them).
  if (model.dropMeshes) {
    const dropped = [];
    for (const mesh of doc.getRoot().listMeshes()) {
      if (model.dropMeshes.test(mesh.getName())) {
        dropped.push(mesh.getName());
        mesh.dispose();
      }
    }
    console.log(`  dropped ${dropped.length} bundled meshes: ${dropped.join(', ')}`);
  }
  // A model with NO clips left has no use for its skin — and while a Skin
  // survives, its JOINTS_0/WEIGHTS_0 attributes ride along in every vertex AND
  // simplify() refuses the primitive outright (skinned meshes are its
  // documented no-op — the Shiba Inu/horse rejection class). prune() alone
  // won't drop it: the nodes still reference it. Stripping it here is what
  // brought the military batch's tanks down ~12 KB each and is what lets
  // simplifyRatio work on the armored vehicles at all (2026-07-29).
  // Guarded on "zero clips remain" so no rigged character is ever touched.
  if (doc.getRoot().listAnimations().length === 0) {
    for (const node of doc.getRoot().listNodes()) node.setSkin(null);
    for (const skin of doc.getRoot().listSkins()) skin.dispose();
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        for (const semantic of ['JOINTS_0', 'WEIGHTS_0']) prim.setAttribute(semantic, null);
      }
    }
  }
  // resample drops redundant keyframes; simplifyRatio (optional) decimates
  // unskinned meshes; meshopt 'high' compresses everything.
  // weld merges vertices whose attributes ALREADY match (tolerance 1e-4), so
  // it is visually lossless and leaves the node hierarchy alone — a game can
  // still find and rotate a tank's turret child. It is also simplify()'s
  // prerequisite. Added 2026-07-29: it is what brings tank_rusty from 150,348 B
  // (348 over the raised line) to 146.8 KB.
  // normalizeLongest (2026-08-06, motorcycle batch): some poly.pizza sources
  // ship at absurd author scales (street_motorcycle measured 15.8 m long) —
  // the library convention is real-world size, so bake a uniform root-node
  // scale that brings the longest axis to the given metres. Node-level, so it
  // is deterministic and survives every later transform untouched.
  // rotateYDeg (2026-08-06, "the sideways black bike"): bake a Y rotation into
  // the root nodes so the model meets the library facing convention (vehicles
  // face +Z at rest — see scripts/lib/orientation.mjs). Node-level like
  // normalizeLongest: deterministic, survives every later transform. The
  // assertLongAxis lint below is what tells a curator this is needed.
  if (model.rotateYDeg) {
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const { composeQuat, rotateVec } = yRotation(model.rotateYDeg);
    for (const node of scene.listChildren()) {
      node.setRotation(composeQuat(node.getRotation()));
      node.setTranslation(rotateVec(node.getTranslation()));
    }
    console.log(`  rotated: ${model.rotateYDeg}° about Y (facing convention)`);
  }
  if (model.normalizeLongest) {
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const { min, max } = getBounds(scene);
    const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    if (longest > 0) {
      const f = model.normalizeLongest / longest;
      for (const node of scene.listChildren()) {
        node.setScale(node.getScale().map((s) => s * f));
        node.setTranslation(node.getTranslation().map((t) => t * f));
      }
      console.log(`  normalized: longest axis ${longest.toFixed(2)} → ${model.normalizeLongest} m`);
    }
  }
  // normalizeFootprint (2026-08-08, BUG-FIX-LOG fragmented race tracks): for
  // MODULAR tiles (roads, race-track pieces) what must land on the grid is the
  // XZ FOOTPRINT. normalizeLongest is the wrong primitive here because it
  // includes Y — a tile with a kerb or a guardrail would get scaled by its
  // HEIGHT and land off-grid. Same node-level bake, XZ-only measure.
  if (model.normalizeFootprint) {
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const { min, max } = getBounds(scene);
    const foot = Math.max(max[0] - min[0], max[2] - min[2]);
    if (foot > 0) {
      const f = model.normalizeFootprint / foot;
      for (const node of scene.listChildren()) {
        node.setScale(node.getScale().map((s) => s * f));
        node.setTranslation(node.getTranslation().map((t) => t * f));
      }
      console.log(`  footprint: ${foot.toFixed(2)} → ${model.normalizeFootprint} m`);
    }
  }
  // recenterXZ (2026-08-08, BUG-FIX-LOG fragmented race tracks): a tile is only
  // layable by `pos = i * modelSize(n).z` if its ORIGIN is the centre of its own
  // footprint. Kenney's city road kit already satisfies this (road_straight
  // measured -0.5..0.5 on both axes); the racing kit does NOT —
  // race_track_straight is a perfect 1 × 1 m tile whose origin sits 1.15 m away
  // in Z, so correct spacing still scatters the geometry. Size alone cannot
  // express that, so we bake the offset out instead of shipping an origin field.
  // XZ only: Y is left alone so tiles keep sitting ON the ground plane, not
  // half-sunk through it.
  if (model.recenterXZ) {
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    const { min, max } = getBounds(scene);
    const dx = (min[0] + max[0]) / 2;
    const dz = (min[2] + max[2]) / 2;
    if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) {
      for (const node of scene.listChildren()) {
        const t = node.getTranslation();
        node.setTranslation([t[0] - dx, t[1], t[2] - dz]);
      }
      console.log(`  recentered: origin moved by (${dx.toFixed(3)}, ${dz.toFixed(3)}) in XZ`);
    }
  }
  const steps = [dedup(), prune(), resample(), weld({ tolerance: 1e-4 })];
  if (model.simplifyRatio) {
    steps.push(simplify({ simplifier: MeshoptSimplifier, ratio: model.simplifyRatio, error: 0.001 }));
  }
  steps.push(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  await doc.transform(...steps);
  // Orientation lint (2026-08-06): entries marked `assertLongAxis: 'z'`
  // (vehicles) must end the pipeline Z-long — nose at +Z, the library facing
  // convention. Runs AFTER all transforms so a rotateYDeg fix is what's
  // measured. Opt-in per entry: characters T-pose X-wide, guns/fences/bridges
  // are legitimately X-long, so a blanket rule would false-positive (full
  // audit 2026-08-06: 77 X-long models, 3 actual defects).
  if (model.assertLongAxis === 'z') {
    const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
    assertLongAxisZ(model.name, getBounds(scene));
  }
  // Published size (2026-08-08, BUG-FIX-LOG fragmented race tracks): the
  // world-space bbox of the model as it will actually render at scale 1.
  // Measured HERE — after every transform, so it describes the bytes we are
  // about to hash, not the source file. getBounds() de-normalizes accessors and
  // applies getWorldMatrix(), so the KHR_mesh_quantization scale meshopt() bakes
  // into the node TRS is handled; it is the same call assertLongAxisZ trusts.
  //
  // SKINNED models are deliberately left without a size rather than given a
  // wrong one: getBounds() has no skin handling, so it reads the BIND-space
  // POSITION accessor and then multiplies by a node matrix that a skinned mesh
  // must ignore per the glTF spec. modelSize() returns null for those and the
  // game eyeballs the scale exactly as it did before this change. A rest-pose
  // skinning pass is TECH_DEBT (cross-repo register).
  //
  // Caveat that must not be lost: for an ANIMATED model this would be a
  // rest-pose snapshot, not a bound swept over the animation — a scale and
  // placement hint, never a collision box.
  const finalScene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  // Centring lint: recenterXZ runs BEFORE the transform steps, so re-measure
  // after them and fail the build if the origin is still off its footprint
  // centre. Without this the bake is silent-on-failure, which is the exact
  // class of bug being fixed.
  if (model.recenterXZ) {
    const { min, max } = getBounds(finalScene);
    const dx = (min[0] + max[0]) / 2;
    const dz = (min[2] + max[2]) / 2;
    if (Math.abs(dx) > 0.005 || Math.abs(dz) > 0.005) {
      throw new Error(
        `${model.name}: tile origin is still off-centre after recenterXZ ` +
          `(${dx.toFixed(3)}, ${dz.toFixed(3)}) — games tile by stepping modelSize(), which assumes a centred origin`,
      );
    }
  }
  let size;
  if (doc.getRoot().listSkins().length > 0) {
    console.log(`  size: omitted — skinned mesh (a bind-pose bbox is not the rendered size)`);
  } else {
    const b = getBounds(finalScene);
    // 3 dp so a re-run produces byte-identical manifest diffs and the JSON that
    // ships to the client stays small.
    size = [0, 1, 2].map((i) => Math.round((b.max[i] - b.min[i]) * 1000) / 1000);
    console.log(`  size: ${size.join(' × ')} m`);
  }
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
  return { bytes, sha256, fileName, url: `${ASSET_HOST_ORIGIN}/${fileName}`, size };
}

const prepared = [];
for (const model of selectedModels) {
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
    license: p.model.license ?? 'CC0',
    ...(p.model.author ? { author: p.model.author } : {}),
    sourceUrl: p.model.sourceUrl,
    sha256: p.sha256,
    // Omitted for skinned models — see the measurement block in prepare().
    ...(p.size ? { size: p.size } : {}),
    // p.model, NOT p: pathAxis is a DECLARATION on the model entry, not
    // something prepare() measures off the bytes (unlike size). Reading it
    // from `p` silently dropped it on every re-vendored entry — caught by the
    // stage-5 contract gate on the 2026-08-08 race_track upload.
    ...(p.model.pathAxis ? { pathAxis: p.model.pathAxis } : {}),
  };
  const existing = manifest.assets.findIndex((a) => a.name === p.model.name);
  if (existing >= 0) manifest.assets[existing] = entryJson;
  else manifest.assets.push(entryJson);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

execFileSync('npx', ['vitest', 'run', 'src/lib/assets/'], { cwd: repo, stdio: 'inherit' });
console.log(`✓ manifest entries written and contract tests green — commit src/lib/assets/manifest.json`);
