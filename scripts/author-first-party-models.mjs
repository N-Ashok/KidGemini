#!/usr/bin/env node
/**
 * First-party CC0 model authoring (2026-07-26 sports batch —
 * docs/2026-07-26_PRD_SportsAssets.md). No CC0 third-party soccer or
 * spinning-top models exist (poly.pizza sports = CC-BY Google-Poly archive;
 * Kenney/Quaternius publish no sports kits; Beyblade meshes are branded), so
 * these are built here and dedicated CC0 (assets-src/LICENSE.md).
 *
 * Outputs into assets-src/models/<name>/raw.glb, the layout the vendor
 * pipeline's `local` source kind copies from (scripts/vendor-models.mjs):
 *   soccer_ball      truncated icosahedron, classic black/white faces
 *   soccer_goal      white post-and-bar frame
 *   battle_top       red/gold spinning battle top (beyblade-style, unbranded)
 *   blade_top        blue/silver variant
 *   footballer       Kenney character-b re-skinned: red kit, white shorts
 *   footballer_blue  same mesh, blue kit
 *
 * Everything is deterministic for a given input + tool version — the asset
 * host is append-only, so re-runs must reproduce identical bytes (same
 * contract as vendor-models.mjs).
 *
 * Flat shading via per-face vertex COLOR_0 (the Quaternius look): three.js
 * multiplies COLOR_0 into the white PBR base color, so no textures needed for
 * the four authored models. The footballers keep Kenney's texture workflow —
 * mesh and rig are untouched; only the atlas PNG is re-painted
 * (scripts/retexture-footballer.py).
 */

import { Document, NodeIO } from '@gltf-transform/core';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const outRoot = join(repo, 'assets-src/models');
const cacheDir = join(repo, '.assets-out/cache');

// Same pinned kit the character library rides (vendor-models.mjs) — CC0 per
// the kenney.nl page and the License.txt in the zip.
const BLOCKY_ZIP_URL = 'https://kenney.nl/media/pages/assets/blocky-characters/8369c0cf30-1749547469/kenney_blocky-characters_20.zip';
const BLOCKY_GLB = 'Models/GLB format/character-b.glb';
const BLOCKY_TEXTURE = 'Models/GLB format/Textures/texture-b.png';

// ── flat-shaded triangle soup builder ───────────────────────────────────────

function meshBuilder() {
  const positions = [];
  const colors = [];
  const normals = [];
  return {
    // a,b,c: [x,y,z] counter-clockwise seen from outside; color: [r,g,b] 0-1.
    tri(a, b, c, color) {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...n) || 1;
      for (const p of [a, b, c]) {
        positions.push(...p);
        normals.push(n[0] / len, n[1] / len, n[2] / len);
        colors.push(...color);
      }
    },
    // Convex polygon (fan-triangulated), points counter-clockwise from outside.
    poly(points, color) {
      for (let i = 1; i < points.length - 1; i++) this.tri(points[0], points[i], points[i + 1], color);
    },
    // Axis-aligned box centered at (cx,cy,cz).
    box(cx, cy, cz, sx, sy, sz, color) {
      const [x, y, z] = [sx / 2, sy / 2, sz / 2];
      const p = (dx, dy, dz) => [cx + dx * x, cy + dy * y, cz + dz * z];
      const faces = [
        [p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)],     // +z
        [p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1)], // -z
        [p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1)],     // +x
        [p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1)], // -x
        [p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1)],     // +y
        [p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1)], // -y
      ];
      for (const f of faces) this.poly(f, color);
    },
    build() {
      return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        colors: new Float32Array(colors),
      };
    },
  };
}

async function writeGlb(name, { positions, normals, colors }) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const material = doc
    .createMaterial('flat_vertex_colors')
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.9);
  const prim = doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer))
    .setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(colors).setBuffer(buffer));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  const node = doc.createNode(name).setMesh(mesh);
  doc.createScene(name).addChild(node);
  const dir = join(outRoot, name);
  await mkdir(dir, { recursive: true });
  const bytes = await new NodeIO().writeBinary(doc);
  await writeFile(join(dir, 'raw.glb'), bytes);
  console.log(`✓ ${name}: ${positions.length / 3} verts → assets-src/models/${name}/raw.glb`);
}

// ── soccer_ball: truncated icosahedron, pentagons black / hexagons white ────

function soccerBall(radius = 0.35) {
  const PHI = (1 + Math.sqrt(5)) / 2;
  let verts = [];
  for (const a of [-1, 1]) for (const b of [-PHI, PHI]) {
    verts.push([0, a, b], [a, b, 0], [b, 0, a]);
  }
  verts = verts.map((v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; });
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let minD = Infinity;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) minD = Math.min(minD, dist(verts[i], verts[j]));
  const adj = Array.from({ length: 12 }, () => []);
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    if (i !== j && dist(verts[i], verts[j]) < minD * 1.01) adj[i].push(j);
  }
  const faces = [];
  for (let i = 0; i < 12; i++) for (const j of adj[i]) for (const k of adj[j]) {
    if (i < j && j < k && adj[i].includes(k)) faces.push([i, j, k]);
  }

  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const scaleTo = (p, r) => { const l = Math.hypot(...p); return [p[0] * r / l, p[1] * r / l, p[2] * r / l]; };

  const b = meshBuilder();
  const BLACK = [0.09, 0.09, 0.1];
  const WHITE = [0.93, 0.93, 0.93];

  // Winds a convex polygon counter-clockwise as seen from outside the sphere.
  const orient = (points, outward) => {
    const c = points.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((x) => x / points.length);
    const u = [points[1][0] - points[0][0], points[1][1] - points[0][1], points[1][2] - points[0][2]];
    const v = [points[2][0] - points[0][0], points[2][1] - points[0][1], points[2][2] - points[0][2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    return n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] > 0 ? points : [...points].reverse();
  };

  // 12 pentagons — one per original vertex, truncation point at 1/3.
  for (let i = 0; i < 12; i++) {
    const v = verts[i];
    const pts = adj[i].map((j) => lerp3(v, verts[j], 1 / 3));
    // Sort around the vertex direction to get a simple polygon.
    const axis = v;
    let ref = pts[0].map((x, k) => x - axis[k] * (pts[0][0] * axis[0] + pts[0][1] * axis[1] + pts[0][2] * axis[2]));
    const refL = Math.hypot(...ref); ref = ref.map((x) => x / refL);
    const ortho = [axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]];
    const angle = (p) => {
      const d = p.map((x, k) => x - axis[k] * (p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2]));
      return Math.atan2(d[0] * ortho[0] + d[1] * ortho[1] + d[2] * ortho[2], d[0] * ref[0] + d[1] * ref[1] + d[2] * ref[2]);
    };
    const ordered = [...pts].sort((p, q) => angle(p) - angle(q)).map((p) => scaleTo(p, radius));
    b.poly(orient(ordered, v), BLACK);
  }

  // 20 hexagons — one per original face; two truncation points per edge.
  for (const [i, j, k] of faces) {
    const [a, c, d] = [verts[i], verts[j], verts[k]];
    const hex = [
      lerp3(a, c, 1 / 3), lerp3(c, a, 1 / 3),
      lerp3(c, d, 1 / 3), lerp3(d, c, 1 / 3),
      lerp3(d, a, 1 / 3), lerp3(a, d, 1 / 3),
    ].map((p) => scaleTo(p, radius));
    const outward = [(a[0] + c[0] + d[0]) / 3, (a[1] + c[1] + d[1]) / 3, (a[2] + c[2] + d[2]) / 3];
    b.poly(orient(hex, outward), WHITE);
  }
  return b.build();
}

// ── soccer_goal: white frame — posts, crossbar, grounded back frame ─────────

function soccerGoal() {
  const b = meshBuilder();
  const WHITE = [0.94, 0.94, 0.94];
  const GREY = [0.75, 0.77, 0.78];
  const T = 0.07;          // bar thickness
  const W = 2.4, H = 1.1, D = 0.8; // opening width/height, net depth
  const x = W / 2;
  b.box(-x, H / 2, 0, T, H, T, WHITE);            // left post
  b.box(x, H / 2, 0, T, H, T, WHITE);             // right post
  b.box(0, H + T / 2, 0, W + T, T, T, WHITE);     // crossbar
  b.box(-x, 0.2, -D, T, 0.4, T, GREY);            // back uprights (low)
  b.box(x, 0.2, -D, T, 0.4, T, GREY);
  b.box(0, 0.4 + T / 2, -D, W + T, T, T, GREY);   // back bar
  b.box(-x, T / 2, -D / 2, T, T, D, GREY);        // ground side bars
  b.box(x, T / 2, -D / 2, T, T, D, GREY);
  b.box(0, T / 2, -D, W + T, T, T, GREY);         // ground back bar
  return b.build();
}

// ── battle tops: lathe bands with alternating blade segments ────────────────

function battleTop({ main, dark, accent, metal }) {
  const b = meshBuilder();
  const SEG = 12;
  // Star rim: alternating per-VERTEX radius makes a 6-point jagged blade ring
  // (continuous surface, no gap walls needed) — the classic battle-top look.
  const star = (i) => (i % 2 ? 0.30 : 0.40);
  // Profile bands: [r0, y0, r1, y1, color] — radii are numbers or per-vertex fns.
  const bands = [
    [0.0, 0.0, 0.09, 0.10, metal],    // tip
    [0.09, 0.10, 0.24, 0.18, dark],   // lower body cone
    [0.24, 0.18, star, 0.22, main],   // under-disc flaring into the blade
    [star, 0.22, star, 0.27, accent], // blade ring (jagged silhouette)
    [star, 0.27, 0.16, 0.34, main],   // top disc
    [0.16, 0.34, 0.10, 0.37, accent], // crown ring
    [0.10, 0.37, 0.09, 0.47, metal],  // stem
  ];
  const rad = (r, i) => (typeof r === 'function' ? r(i) : r);
  const pt = (r, y, i) => {
    const a = (i / SEG) * Math.PI * 2;
    return [rad(r, i) * Math.cos(a), y, rad(r, i) * Math.sin(a)];
  };
  for (const [r0, y0, r1, y1, color] of bands) {
    for (let i = 0; i < SEG; i++) {
      const [a0, a1] = [pt(r0, y0, i), pt(r0, y0, i + 1)];
      const [b0, b1] = [pt(r1, y1, i), pt(r1, y1, i + 1)];
      // Outward-facing quad (counter-clockwise from outside).
      if (rad(r0, i) > 0 || rad(r0, i + 1) > 0) b.tri(a0, b0, b1, color);
      b.tri(a0, b1, a1, color);
    }
  }
  // Stem cap.
  for (let i = 0; i < SEG; i++) b.tri([0, 0.47, 0], pt(0.09, 0.47, i + 1), pt(0.09, 0.47, i), metal);
  return b.build();
}

const TOP_RED = { main: [0.78, 0.16, 0.18], dark: [0.55, 0.10, 0.12], accent: [0.92, 0.72, 0.20], metal: [0.55, 0.56, 0.60] };
const TOP_BLUE = { main: [0.16, 0.32, 0.78], dark: [0.10, 0.20, 0.55], accent: [0.78, 0.81, 0.85], metal: [0.55, 0.56, 0.60] };

// ── footballers: Kenney character-b mesh + re-painted atlas ─────────────────

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function buildFootballers() {
  await mkdir(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, BLOCKY_ZIP_URL.split('/').pop());
  if (!existsSync(zipPath)) {
    console.log(`  ↓ ${BLOCKY_ZIP_URL}`);
    await download(BLOCKY_ZIP_URL, zipPath);
  }
  const stage = join(cacheDir, 'footballer-src');
  await mkdir(stage, { recursive: true });
  execFileSync('unzip', ['-o', '-j', zipPath, BLOCKY_GLB, BLOCKY_TEXTURE, '-d', stage], { stdio: 'pipe' });

  for (const [name, kit] of [['footballer', 'red'], ['footballer_blue', 'blue']]) {
    const dir = join(outRoot, name);
    await mkdir(join(dir, 'Textures'), { recursive: true });
    await copyFile(join(stage, 'character-b.glb'), join(dir, 'raw.glb'));
    execFileSync('python3', [
      join(repo, 'scripts/retexture-footballer.py'),
      join(stage, 'texture-b.png'),
      join(dir, 'Textures/texture-b.png'),
      kit,
    ], { stdio: 'inherit' });
    console.log(`✓ ${name}: character-b + ${kit} kit atlas → assets-src/models/${name}/`);
  }
}


// ── cricket (2026-07-29, docs/2026-07-29_PRD_CricketAssets.md) ──────────────
// Authored rather than downloaded because the free 3D pool has essentially NO
// cricket: a license sweep of poly.pizza (14 terms, 2026-07-29) found zero CC0
// cricket assets, and only two CC-BY bats at ANY license — no ball, no stumps,
// no player. Relaxing the CC0 policy would not have helped, so there was
// nothing to vendor. Same conclusion, and same remedy, as the soccer set.

const WILLOW = [0.86, 0.76, 0.55];
const WILLOW_DARK = [0.72, 0.61, 0.42];
const GRIP = [0.15, 0.15, 0.18];
const BALL_RED = [0.62, 0.09, 0.12];
const SEAM_WHITE = [0.94, 0.93, 0.90];
const STUMP_WOOD = [0.90, 0.82, 0.62];
const PITCH_TAN = [0.80, 0.73, 0.52];
const CREASE = [0.96, 0.96, 0.94];

/** Revolved solid from [r0,y0,r1,y1,color] bands — same lathe the battle tops
 *  use, factored out here so the bat handle and the stumps share it. */
function lathe(b, bands, seg = 10) {
  const pt = (r, y, i) => {
    const a = (i / seg) * Math.PI * 2;
    return [r * Math.cos(a), y, r * Math.sin(a)];
  };
  for (const [r0, y0, r1, y1, color] of bands) {
    for (let i = 0; i < seg; i++) {
      const [a0, a1] = [pt(r0, y0, i), pt(r0, y0, i + 1)];
      const [c0, c1] = [pt(r1, y1, i), pt(r1, y1, i + 1)];
      if (r0 > 0) b.tri(a0, c0, c1, color);
      if (r1 > 0) b.tri(a0, c1, a1, color);
    }
  }
}

/** Cricket bat: the FLAT-faced blade is what distinguishes it from a baseball
 *  bat — a round bat reads as the wrong sport instantly, which is why the CC0
 *  baseball bats were not reused. Blade down, handle up, origin at the middle. */
function cricketBat() {
  const b = meshBuilder();
  b.box(0, -0.20, 0, 0.11, 0.56, 0.035, WILLOW);        // blade face
  b.box(0, -0.20, -0.028, 0.075, 0.50, 0.025, WILLOW_DARK); // spine ridge (back)
  b.box(0, 0.10, 0, 0.045, 0.06, 0.035, WILLOW_DARK);   // shoulder
  lathe(b, [
    [0.018, 0.13, 0.018, 0.34, GRIP],                    // handle grip
    [0.018, 0.34, 0.021, 0.36, GRIP],                    // butt flare
  ]);
  b.box(0, 0.36, 0, 0.042, 0.012, 0.042, GRIP);          // butt cap
  return b.build();
}

/** Cricket ball: red sphere with a raised white seam ring — the seam is the
 *  read, so it is a real band of geometry, not a texture. */
function cricketBall(radius = 0.036) {
  const b = meshBuilder();
  const RINGS = 16, SEG = 14;
  const p = (lat, lon) => {
    const th = (lat / RINGS) * Math.PI, ph = (lon / SEG) * Math.PI * 2;
    // Seam ring sits slightly proud so it catches the light.
    const r = radius * (lat === RINGS / 2 ? 1.025 : 1);
    return [r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)];
  };
  for (let lat = 0; lat < RINGS; lat++) {
    // ONE band, not two: at RINGS=10 a two-band seam spanned 36 degrees and
    // read as a beach-ball stripe in the render pass (2026-07-29). A single
    // band at RINGS=16 is ~11 degrees — a stitch line, which is the point.
    const seam = lat === RINGS / 2;
    for (let lon = 0; lon < SEG; lon++) {
      const [a, bb, c, d] = [p(lat, lon), p(lat, lon + 1), p(lat + 1, lon + 1), p(lat + 1, lon)];
      const col = seam ? SEAM_WHITE : BALL_RED;
      if (lat !== 0) b.tri(a, c, bb, col);
      if (lat !== RINGS - 1) b.tri(a, d, c, col);
    }
  }
  return b.build();
}

/** Wicket: three stumps + two bails as ONE model, so a game places a whole
 *  wicket in a single loadModel call rather than positioning five pieces. */
function wicket() {
  const b = meshBuilder();
  const H = 0.71, R = 0.017;
  // A regulation wicket is 9in (0.2286 m) wide overall — the first pass used
  // 0.055 spacing (0.14 m total), which the render pass showed as a wicket a
  // ball could sail through. Outer stumps sit at +/-0.0955 so the outer faces
  // land on 0.2286.
  for (const x of [-0.0955, 0, 0.0955]) {
    const bands = [[R, 0, R, H, STUMP_WOOD], [R, H, R * 0.6, H + 0.02, STUMP_WOOD]];
    const sub = meshBuilder();
    lathe(sub, bands);
    const { positions, normals, colors } = sub.build();
    for (let i = 0; i < positions.length; i += 9) {
      const v = (k) => [positions[i + k] + x, positions[i + k + 1], positions[i + k + 2]];
      b.tri(v(0), v(3), v(6), [colors[i], colors[i + 1], colors[i + 2]]);
    }
  }
  for (const x of [-0.0478, 0.0478]) b.box(x, H + 0.030, 0, 0.105, 0.016, 0.016, WILLOW_DARK); // bails span stump-to-stump
  return b.build();
}

/** The 22-yard strip with both popping creases — gives a cricket game a
 *  correct playing surface instead of a guessed rectangle. */
function cricketPitch() {
  const b = meshBuilder();
  b.box(0, 0, 0, 3.05, 0.02, 20.12, PITCH_TAN);         // 10ft x 22yd, scaled 1u = 1m
  for (const z of [-8.84, 8.84]) {
    b.box(0, 0.012, z, 2.64, 0.006, 0.05, CREASE);       // popping crease
    b.box(0, 0.012, z + (z < 0 ? 1.22 : -1.22), 2.64, 0.006, 0.05, CREASE); // bowling crease
  }
  return b.build();
}

/** Sight screen — the white panel behind the bowler's arm. */
function sightScreen() {
  const b = meshBuilder();
  b.box(0, 1.30, 0, 3.20, 2.20, 0.08, [0.95, 0.95, 0.93]);
  for (const x of [-1.35, 1.35]) b.box(x, 0.35, 0, 0.10, 0.70, 0.10, [0.45, 0.45, 0.48]);
  return b.build();
}

async function buildCricketer() {
  const stage = join(cacheDir, 'blocky-characters');
  const zipPath = join(cacheDir, 'kenney_blocky-characters_20.zip');
  await mkdir(stage, { recursive: true });
  if (!existsSync(zipPath)) {
    const res = await fetch(BLOCKY_ZIP_URL);
    if (!res.ok) throw new Error(`blocky zip → HTTP ${res.status}`);
    await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  execFileSync('unzip', ['-o', '-j', zipPath, BLOCKY_GLB, BLOCKY_TEXTURE, '-d', stage], { stdio: 'pipe' });
  const dir = join(outRoot, 'cricketer');
  await mkdir(join(dir, 'Textures'), { recursive: true });
  await copyFile(join(stage, 'character-b.glb'), join(dir, 'raw.glb'));
  execFileSync('python3', [
    join(repo, 'scripts/retexture-footballer.py'),
    join(stage, 'texture-b.png'), join(dir, 'Textures/texture-b.png'), 'whites',
  ], { stdio: 'inherit' });
  console.log(`✓ cricketer: character-b + whites atlas → assets-src/models/cricketer/`);
}

// ── indian games (2026-07-30, docs/2026-07-30_PRD_IndianGamesAssets.md) ─────
// Kabaddi, carrom, kho-kho, badminton, ludo, marbles — a poly.pizza/Kenney/
// Quaternius sweep (2026-07-30) found NO usable CC0 model for any of the six
// (PRD §1). Same remedy as soccer/cricket: author here, dedicate CC0.

const MAT_SAND = [0.85, 0.75, 0.45];
const LINE_WHITE = [0.95, 0.95, 0.92];
const CARROM_WOOD = [0.62, 0.45, 0.28];
const CARROM_CREAM = [0.90, 0.82, 0.62];
const CARROM_LINE = [0.15, 0.15, 0.15];
const STRIKER_WHITE = [0.92, 0.90, 0.85];
const COIN_WHITE = [0.93, 0.91, 0.86];
const COIN_BLACK = [0.12, 0.11, 0.13];
const QUEEN_RED = [0.72, 0.10, 0.13];
const POLE_WOOD = [0.75, 0.55, 0.32];
const FIELD_GREEN = [0.36, 0.55, 0.28];
const RACKET_FRAME = [0.80, 0.14, 0.14];
const RACKET_STRING = [0.88, 0.88, 0.84];
const GRIP_BLACK = [0.15, 0.15, 0.15];
const SHUTTLE_WHITE = [0.95, 0.95, 0.92];
const SHUTTLE_CORK = [0.85, 0.75, 0.55];
const NET_WHITE = [0.96, 0.96, 0.96];
const NET_POST = [0.30, 0.30, 0.32];
const LUDO_CREAM = [0.94, 0.92, 0.85];
const LUDO_HOME = [0.98, 0.96, 0.90];
const PAWN_RED = [0.80, 0.15, 0.15];
const PAWN_GREEN = [0.15, 0.60, 0.25];
const PAWN_YELLOW = [0.90, 0.75, 0.15];
const PAWN_BLUE = [0.15, 0.35, 0.80];
const DICE_WHITE = [0.95, 0.95, 0.92];
const DICE_DOT = [0.10, 0.10, 0.10];
const MARBLE_CLEAR = [0.75, 0.85, 0.92];
const MARBLE_BLUE = [0.20, 0.40, 0.85];
const MARBLE_GREEN = [0.20, 0.70, 0.35];

/** Winds a convex polygon so its normal points toward `outward` — the same
 *  correctness trick soccerBall() uses inline, factored here so every new
 *  flat-cap shape (discs, rings, pips) gets it for free without re-deriving
 *  cross-product sign logic per shape. */
function orient(points, outward) {
  const u = [points[1][0] - points[0][0], points[1][1] - points[0][1], points[1][2] - points[0][2]];
  const v = [points[2][0] - points[0][0], points[2][1] - points[0][1], points[2][2] - points[0][2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] > 0 ? points : [...points].reverse();
}

/** Filled circle in the XZ plane (a table lying flat) at height y. */
function circleXZ(cx, y, cz, r, seg, color, outward) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), y, cz + r * Math.sin(a)]);
  }
  return orient(pts, outward).map((p) => p); // caller adds via b.poly
}

/** A flat disc standing at the origin — top+bottom caps plus a rim wall.
 *  Used for every coin/striker/queen-piece shape (all colour variants of one
 *  geometry, per the PRD's carrom-coin / ludo-pawn / marble pattern). */
function flatDisc(radius, height, color, seg = 16) {
  const b = meshBuilder();
  lathe(b, [[radius, 0, radius, height, color]], seg);
  b.poly(circleXZ(0, height, 0, radius, seg, color, [0, 1, 0]), color);
  b.poly(circleXZ(0, 0, 0, radius, seg, color, [0, -1, 0]), color);
  return b.build();
}

/** UV sphere at the origin, single flat color — the marble geometry (and the
 *  same technique cricketBall() uses, minus the seam band). */
function uvSphere(radius, color, rings = 10, seg = 12) {
  const b = meshBuilder();
  const p = (lat, lon) => {
    const th = (lat / rings) * Math.PI, ph = (lon / seg) * Math.PI * 2;
    return [radius * Math.sin(th) * Math.cos(ph), radius * Math.cos(th), radius * Math.sin(th) * Math.sin(ph)];
  };
  for (let lat = 0; lat < rings; lat++) {
    for (let lon = 0; lon < seg; lon++) {
      const [a, bb, c, d] = [p(lat, lon), p(lat, lon + 1), p(lat + 1, lon + 1), p(lat + 1, lon)];
      if (lat !== 0) b.tri(a, c, bb, color);
      if (lat !== rings - 1) b.tri(a, d, c, color);
    }
  }
  return b.build();
}

/** Kabaddi court: regulation 13m x 10m mat, centre line + baulk lines at
 *  ±3.75 m (men's dimensions), boundary lines painted via vertex colour. */
function kabaddiMat() {
  const b = meshBuilder();
  const W = 10, L = 13;
  b.box(0, 0, 0, W, 0.02, L, MAT_SAND);
  b.box(0, 0.011, 0, W, 0.006, 0.08, LINE_WHITE); // centre line
  for (const z of [-3.75, 3.75]) b.box(0, 0.011, z, W, 0.006, 0.05, LINE_WHITE); // baulk lines
  for (const z of [-L / 2 + 0.03, L / 2 - 0.03]) b.box(0, 0.011, z, W, 0.006, 0.05, LINE_WHITE);
  for (const x of [-W / 2 + 0.03, W / 2 - 0.03]) b.box(x, 0.011, 0, 0.05, 0.006, L, LINE_WHITE);
  return b.build();
}

/** Carrom board: 74cm playing surface inside an 82cm wooden frame, four
 *  corner pockets, a centre circle, and diagonal guide lines (all vertex
 *  colour — no real pocket holes, matching the "flat, vertex-colour" budget
 *  every model in this file uses). */
function carromBoard() {
  const b = meshBuilder();
  const S = 0.82, P = 0.74;
  b.box(0, 0, 0, S, 0.02, S, CARROM_WOOD);
  b.box(0, 0.011, 0, P, 0.004, P, CARROM_CREAM);
  // Diagonal guide lines, corner to corner — built as thin rotated quads
  // (poly(), not box(): box() is axis-aligned only).
  const half = P / 2 - 0.06, w = 0.008, y = 0.014;
  for (const [dx, dz] of [[1, 1], [1, -1]]) {
    const nx = -dz * w / Math.SQRT2, nz = dx * w / Math.SQRT2;
    const p1 = [-dx * half + nx, y, -dz * half + nz];
    const p2 = [dx * half + nx, y, dz * half + nz];
    const p3 = [dx * half - nx, y, dz * half - nz];
    const p4 = [-dx * half - nx, y, -dz * half - nz];
    b.poly(orient([p1, p2, p3, p4], [0, 1, 0]), CARROM_LINE);
  }
  b.poly(circleXZ(0, 0.014, 0, 0.09, 20, CARROM_LINE, [0, 1, 0]), CARROM_LINE);
  b.poly(circleXZ(0, 0.015, 0, 0.06, 20, CARROM_CREAM, [0, 1, 0]), CARROM_CREAM);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b.poly(circleXZ(x * (P / 2 - 0.05), 0.014, z * (P / 2 - 0.05), 0.032, 14, CARROM_LINE, [0, 1, 0]), CARROM_LINE);
  }
  return b.build();
}

/** Regulation carrom striker: ~4.2cm diameter flat cylinder. */
function carromStriker() { return flatDisc(0.021, 0.009, STRIKER_WHITE); }
/** Regulation coins: ~3.2cm diameter, thin. White/black are colour variants
 *  of the SAME geometry (PRD's colour-variant pattern). */
function carromCoinWhite() { return flatDisc(0.016, 0.006, COIN_WHITE); }
function carromCoinBlack() { return flatDisc(0.016, 0.006, COIN_BLACK); }
/** The queen: same coin geometry, red. */
function carromQueen() { return flatDisc(0.016, 0.006, QUEEN_RED); }

/** Kho-kho pole: the post planted at each end of the lane — ONE model,
 *  placed twice per field (PRD §2.3). ~1.2m tall, tapered cap. */
function khoKhoPole() {
  // Regulation pole height is 120-125cm overall INCLUDING the rounded cap —
  // the render pass (2026-07-30) caught a first pass that added the cap ON
  // TOP of a full 1.20m pole (1.32m total, over regulation), same class of
  // defect the cricket batch's wicket-width bug was. Fixed: the cap eats into
  // the 1.23m total instead of extending past it.
  const b = meshBuilder();
  lathe(b, [[0.045, 0, 0.045, 1.20, POLE_WOOD], [0.045, 1.20, 0.018, 1.23, POLE_WOOD]], 10);
  b.poly(circleXZ(0, 0, 0, 0.045, 10, POLE_WOOD, [0, -1, 0]), POLE_WOOD);
  b.poly(circleXZ(0, 1.23, 0, 0.018, 10, POLE_WOOD, [0, 1, 0]), POLE_WOOD);
  return b.build();
}

/** Kho-kho field: the central lane with 8 cross-lanes (regulation-shaped
 *  rectangle, simplified to a flat green field with painted lines). */
function khoKhoLaneField() {
  const b = meshBuilder();
  const W = 16, L = 29;
  b.box(0, 0, 0, W, 0.02, L, FIELD_GREEN);
  b.box(0, 0.011, 0, 0.08, 0.006, L, LINE_WHITE); // central lane
  for (let i = -3.5; i <= 3.5; i++) b.box(0, 0.011, i * 3.5, W, 0.006, 0.05, LINE_WHITE); // 8 cross lanes
  return b.build();
}

/** Badminton racket: lathe-revolved grip + shaft, an oval "hoop" ring in the
 *  XY plane (racket held handle-down, hoop facing the camera), with a flat
 *  low-poly "strung" cross-hatch via vertex colour (not real string
 *  geometry, per the PRD). ~0.67m overall, regulation racket length. */
function badmintonRacket() {
  // Regulation caps: overall length <= 680mm, overall width <= 230mm. The
  // render pass (2026-07-30) caught a first pass at 495mm total (grip 150 +
  // shaft 210 + hoop radius 135) — well under length, and 270mm hoop diameter
  // — over the width cap. Refit: hoop centre pushed further up the shaft and
  // the hoop shrunk so length and width both land inside regulation.
  const b = meshBuilder();
  lathe(b, [[0.010, 0, 0.010, 0.15, GRIP_BLACK]], 10); // grip
  const gripBottom = [];
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; gripBottom.push([0.010 * Math.cos(a), 0, 0.010 * Math.sin(a)]); }
  b.poly(orient(gripBottom, [0, -1, 0]), GRIP_BLACK);
  lathe(b, [[0.010, 0.15, 0.005, 0.15, RACKET_FRAME], [0.005, 0.15, 0.005, 0.56, RACKET_FRAME]], 10); // shaft

  // Hoop ring + string bed live in the XY plane (normal along Z).
  const hoopY = 0.56, R = 0.11, Rin = 0.095;
  const ringPt = (r, i, seg) => { const a = (i / seg) * Math.PI * 2; return [r * Math.cos(a), hoopY + r * Math.sin(a), 0]; };
  const SEG = 16;
  for (let i = 0; i < SEG; i++) {
    const o0 = ringPt(R, i, SEG), o1 = ringPt(R, i + 1, SEG), i0 = ringPt(Rin, i, SEG), i1 = ringPt(Rin, i + 1, SEG);
    b.poly(orient([o0, o1, i1, i0], [0, 0, 1]), RACKET_FRAME);
    b.poly(orient([o0, o1, i1, i0], [0, 0, -1]), RACKET_FRAME);
  }
  // String bed: a thin disc plus a light cross-hatch (vertex colour only).
  const bedPts = (r) => { const pts = []; for (let i = 0; i < SEG; i++) pts.push(ringPt(r, i, SEG)); return pts; };
  b.poly(orient(bedPts(Rin), [0, 0, 1]), RACKET_STRING);
  b.poly(orient([...bedPts(Rin)].reverse(), [0, 0, -1]), RACKET_STRING);
  for (let i = -2; i <= 2; i++) {
    const t = (i / 3) * Rin;
    b.poly(orient([[-Rin * 0.9, hoopY + t - 0.0015, 0.0005], [Rin * 0.9, hoopY + t - 0.0015, 0.0005], [Rin * 0.9, hoopY + t + 0.0015, 0.0005], [-Rin * 0.9, hoopY + t + 0.0015, 0.0005]], [0, 0, 1]), GRIP_BLACK);
    b.poly(orient([[t - 0.0015, hoopY - Rin * 0.9, 0.0006], [t + 0.0015, hoopY - Rin * 0.9, 0.0006], [t + 0.0015, hoopY + Rin * 0.9, 0.0006], [t - 0.0015, hoopY + Rin * 0.9, 0.0006]], [0, 0, 1]), GRIP_BLACK);
  }
  return b.build();
}

/** Shuttlecock: a small cork base with a fan of thin triangular "feathers" —
 *  the classic birdie silhouette at very low poly count (PRD §2.4). */
function shuttlecock() {
  const b = meshBuilder();
  lathe(b, [[0, 0, 0.008, 0, SHUTTLE_CORK], [0.008, 0, 0.006, 0.012, SHUTTLE_CORK]], 10);
  const bottom = [];
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; bottom.push([0.008 * Math.cos(a), 0, 0.008 * Math.sin(a)]); }
  b.poly(orient(bottom, [0, -1, 0]), SHUTTLE_CORK);
  const FEATHERS = 12, topR = 0.032, height = 0.07;
  for (let i = 0; i < FEATHERS; i++) {
    const a = (i / FEATHERS) * Math.PI * 2;
    const base = [0.006 * 0.5 * Math.cos(a), 0.010, 0.006 * 0.5 * Math.sin(a)];
    const flare = [topR * Math.cos(a), height * 0.45, topR * Math.sin(a)];
    const tip = [topR * 1.05 * Math.cos(a + 0.04), height, topR * 1.05 * Math.sin(a + 0.04)];
    b.tri(base, flare, tip, SHUTTLE_WHITE);
  }
  return b.build();
}

/** Badminton net: regulation 6.1m wide, cloth top at 1.55m dropping 0.76m,
 *  with two posts. */
function badmintonNet() {
  const b = meshBuilder();
  const W = 6.1, cloth = 0.76, top = 1.55;
  b.box(0, top - cloth / 2, 0, W, cloth, 0.01, NET_WHITE);
  b.box(0, top + 0.02, 0, W, 0.04, 0.02, NET_WHITE);
  for (const x of [-W / 2, W / 2]) b.box(x, top / 2, 0, 0.05, top, 0.05, NET_POST);
  return b.build();
}

/** Ludo board: flat square, four coloured quadrant "yards", a cream centre
 *  home area (PRD §2.5). */
function ludoBoard() {
  const b = meshBuilder();
  const S = 0.45, q = S / 2 / 2, cell = S / 2 - 0.02;
  b.box(0, 0, 0, S, 0.015, S, LUDO_CREAM);
  b.box(-q, 0.008, -q, cell, 0.006, cell, PAWN_RED);
  b.box(q, 0.008, -q, cell, 0.006, cell, PAWN_GREEN);
  b.box(-q, 0.008, q, cell, 0.006, cell, PAWN_BLUE);
  b.box(q, 0.008, q, cell, 0.006, cell, PAWN_YELLOW);
  b.box(0, 0.009, 0, S * 0.28, 0.006, S * 0.28, LUDO_HOME);
  return b.build();
}

/** Ludo die: a cube with pip dots on three visible faces (top/front/right) —
 *  enough to read as a die at this poly count without modelling all six. */
function ludoDice() {
  const b = meshBuilder();
  const S = 0.016, pip = 0.003, d = S / 2 + 0.0006;
  b.box(0, 0, 0, S, S, S, DICE_WHITE);
  b.box(0, d, 0, pip, 0.0012, pip, DICE_DOT); // top: 1
  b.box(-0.004, 0.004, d, pip, pip, 0.0012, DICE_DOT); // front: 2
  b.box(0.004, -0.004, d, pip, pip, 0.0012, DICE_DOT);
  b.box(d, 0.005, -0.005, 0.0012, pip, pip, DICE_DOT); // right: 3
  b.box(d, 0, 0, 0.0012, pip, pip, DICE_DOT);
  b.box(d, -0.005, 0.005, 0.0012, pip, pip, DICE_DOT);
  return b.build();
}

/** Ludo pawn: a cone-on-disc peg, colour-variant per player (PRD §2.5's
 *  coin-pattern re-use — one geometry, four colours). */
function ludoPawn(color) {
  const b = meshBuilder();
  lathe(b, [
    [0.012, 0, 0.012, 0.006, color],
    [0.012, 0.006, 0.003, 0.030, color],
    [0.003, 0.030, 0.003, 0.034, color],
    [0.003, 0.034, 0.006, 0.038, color],
  ], 12);
  b.poly(circleXZ(0, 0, 0, 0.012, 12, color, [0, -1, 0]), color);
  b.poly(circleXZ(0, 0.038, 0, 0.006, 12, color, [0, 1, 0]), color);
  return b.build();
}

/** Marble: a UV sphere; blue/green are colour variants of the same geometry
 *  (matching the coin/pawn pattern, PRD §2.6). Regulation glass marble ~16mm. */
function marble() { return uvSphere(0.008, MARBLE_CLEAR); }
function marbleBlue() { return uvSphere(0.008, MARBLE_BLUE); }
function marbleGreen() { return uvSphere(0.008, MARBLE_GREEN); }

// ── motorcycles (2026-08-06 batch — docs/2026-08-06_PRD_MotorcycleAssets.md) ─
// The CC0 pool holds exactly ONE motorcycle (poly.pizza /m/j20srJUjpB, vendored
// as `motorcycle` in vendor-models.mjs); every other two-wheeler on poly.pizza
// is CC-BY 3.0, and Kenney/Quaternius publish none. Same remedy as
// cricket/Indian games: first-party, dedicated CC0 (assets-src/LICENSE.md).
//
// One parameterized skeleton, ten reads. Convention: forward = +Z, up = +Y,
// bike symmetric about x = 0, ground at y = 0 — wheels rotate about X, matching
// how a kid's game drives the Kenney cars (move position, yaw about Y).

const TIRE = [0.13, 0.13, 0.15];
const RIM = [0.72, 0.73, 0.76];
const ENGINE_GRAY = [0.42, 0.43, 0.47];
const CHROME = [0.80, 0.81, 0.85];
const SEAT_BLACK = [0.16, 0.16, 0.19];
const HEADLIGHT = [0.98, 0.95, 0.80];
const TAILLIGHT = [0.85, 0.15, 0.12];
const SPORT_RED = [0.82, 0.14, 0.16];
const RACE_GREEN = [0.16, 0.62, 0.30];
const PLATE_WHITE = [0.95, 0.95, 0.93];
const DIRT_ORANGE = [0.92, 0.45, 0.10];
const CRUISER_BLUE = [0.14, 0.25, 0.52];
const CHOPPER_BLACK = [0.10, 0.10, 0.12];
const POLICE_WHITE = [0.93, 0.94, 0.95];
const POLICE_BLUE = [0.12, 0.25, 0.60];
const LIGHT_RED = [0.90, 0.12, 0.10];
const LIGHT_BLUE = [0.15, 0.35, 0.95];
const SCOOTER_TEAL = [0.10, 0.55, 0.55];
const MOPED_CREAM = [0.91, 0.86, 0.72];
const DELIVERY_ORANGE = [0.95, 0.52, 0.08];
const BOX_BROWN = [0.62, 0.45, 0.28];
const MINI_YELLOW = [0.95, 0.78, 0.12];
const WINDSHIELD = [0.72, 0.83, 0.90];

/** Box tilted about the X axis (the only rotation a bike profile needs —
 *  forks, frame beams and windshields all lean in the YZ plane). tilt > 0
 *  leans the top toward +Z (forward). */
function tiltBox(b, cx, cy, cz, sx, sy, sz, tilt, color) {
  const [x, y, z] = [sx / 2, sy / 2, sz / 2];
  const [cs, sn] = [Math.cos(tilt), Math.sin(tilt)];
  const p = (dx, dy, dz) => {
    const [oy, oz] = [dy * y, dz * z];
    return [cx + dx * x, cy + oy * cs - oz * sn, cz + oy * sn + oz * cs];
  };
  const faces = [
    [p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1)],
    [p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1)],
    [p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1)],
    [p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1)],
    [p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1)],
    [p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1)],
  ];
  for (const f of faces) b.poly(f, color);
}

/** Box strut whose long axis runs from (y0,z0) to (y1,z1) in the YZ plane at
 *  lateral offset x — forks, frame beams and aprons are all strut calls.
 *  tiltBox rotates +Z onto (−sin t, cos t) in YZ, so t = atan2(−dy, dz). */
function strut(b, x, [y0, z0], [y1, z1], sx, thick, color, overlap = 0.06) {
  const [dy, dz] = [y1 - y0, z1 - z0];
  const len = Math.hypot(dy, dz) + overlap;
  tiltBox(b, x, (y0 + y1) / 2, (z0 + z1) / 2, sx, thick, len, Math.atan2(-dy, dz), color);
}

/** Wheel on the X axle at (0, cy, cz): tire tread band + side walls + hub
 *  discs. seg 14 reads road-smooth; seg 8 reads knobby (dirt/mini). */
function wheel(b, cy, cz, r, w, seg = 14) {
  const rim = (x, out) => {
    const pts = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push([x, cy + r * Math.cos(a), cz + r * Math.sin(a)]);
    }
    return orient(pts, out);
  };
  b.poly(rim(w / 2, [1, 0, 0]), TIRE);
  b.poly(rim(-w / 2, [-1, 0, 0]), TIRE);
  for (let i = 0; i < seg; i++) {
    const [a0, a1] = [(i / seg) * Math.PI * 2, ((i + 1) / seg) * Math.PI * 2];
    const e = (a, x) => [x, cy + r * Math.cos(a), cz + r * Math.sin(a)];
    b.poly(orient([e(a0, w / 2), e(a0, -w / 2), e(a1, -w / 2), e(a1, w / 2)],
      [0, Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2)]), TIRE);
  }
  const hr = r * 0.45, hw = w / 2 + 0.012;
  const hub = (x, out) => {
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push([x, cy + hr * Math.cos(a), cz + hr * Math.sin(a)]);
    }
    return orient(pts, out);
  };
  b.poly(hub(hw, [1, 0, 0]), RIM);
  b.poly(hub(-hw, [-1, 0, 0]), RIM);
}

/** The shared motorcycle skeleton. Every dimension a variant needs to change
 *  is a named option; `extras(b, o)` adds the variant's signature pieces. */
function motorcycleBase(opts) {
  const o = {
    wheelR: 0.30, wheelW: 0.10, rearZ: -0.62, frontZ: 0.62, seg: 14,
    forkTilt: 0.42,          // rake, radians about X
    barY: 0.98,              // handlebar height
    seatY: 0.72, seatZ: -0.32, seatLen: 0.42,
    tankY: 0.80, tankZ: 0.12,
    body: SPORT_RED, hasEngine: true, hasTank: true,
    ...opts,
  };
  const b = meshBuilder();
  wheel(b, o.wheelR, o.rearZ, o.wheelR, o.wheelW, o.seg);
  wheel(b, o.wheelR, o.frontZ, o.wheelR, o.wheelW, o.seg);

  // Front fork: twin legs from the steering head down to the front axle.
  const headY = o.barY - 0.10;
  const headZ = o.frontZ - Math.tan(o.forkTilt) * (headY - o.wheelR);
  for (const x of [-0.05, 0.05]) {
    strut(b, x, [o.wheelR, o.frontZ], [headY, headZ], 0.04, 0.05, CHROME);
  }
  // Handlebar: crossbar + grips.
  b.box(0, o.barY, headZ - 0.02, 0.46, 0.045, 0.05, ENGINE_GRAY);
  b.box(-0.23, o.barY + 0.01, headZ - 0.02, 0.09, 0.055, 0.055, SEAT_BLACK);
  b.box(0.23, o.barY + 0.01, headZ - 0.02, 0.09, 0.055, 0.055, SEAT_BLACK);
  // Headlight on the steering head.
  b.box(0, headY, headZ + 0.10, 0.14, 0.14, 0.06, HEADLIGHT);

  // Main frame beam: rear axle up to the steering head.
  strut(b, 0, [o.wheelR + 0.16, o.rearZ], [headY - 0.04, headZ - 0.02], 0.10, 0.10, o.body);

  // Engine, tank, seat, rear fender, tail light, exhaust — all scaled to the
  // wheelbase so a small bike keeps small organs (the mini_bike's full-size
  // engine block swallowed its rear wheel on the first render pass).
  const s = (o.frontZ - o.rearZ) / 1.24;
  if (o.hasEngine) b.box(0, o.wheelR + 0.06 * s, (o.rearZ + o.frontZ) / 2, 0.20 * s, 0.24 * s, 0.34 * s, ENGINE_GRAY);
  if (o.hasTank) b.box(0, o.tankY, o.tankZ, 0.20, 0.16, 0.36 * s, o.body);
  b.box(0, o.seatY, o.seatZ, 0.20, 0.07, o.seatLen, SEAT_BLACK);
  b.box(0, o.wheelR + 0.14, o.rearZ - 0.05, 0.14, 0.05, 0.34 * s, o.body);
  b.box(0, o.wheelR + 0.17, o.rearZ - 0.20 * s, 0.10, 0.05, 0.05, TAILLIGHT);
  b.box(0.12, o.wheelR - 0.02, (o.rearZ + o.frontZ) / 2 - 0.1 * s, 0.07, 0.07, 0.55 * s, CHROME);
  // Kickstand-ish rear swingarm hint.
  b.box(0, o.wheelR, o.rearZ / 2, 0.06, 0.06, -o.rearZ, ENGINE_GRAY);

  if (o.extras) o.extras(b, o, { headY, headZ });
  return b.build();
}

/** Step-through body (scooter/moped/delivery): no exposed engine or tank —
 *  floorboard, front apron and an under-seat tail instead. */
function scooterBase(opts) {
  const o = {
    wheelR: 0.19, wheelW: 0.09, rearZ: -0.45, frontZ: 0.45, seg: 14,
    forkTilt: 0.20, barY: 0.92, seatY: 0.70, seatZ: -0.25, seatLen: 0.34,
    body: SCOOTER_TEAL, hasEngine: false, hasTank: false,
    ...opts,
  };
  return motorcycleBase({
    ...o,
    extras(b, oo, ctx) {
      b.box(0, oo.wheelR + 0.05, 0.02, 0.26, 0.06, 0.5, oo.body);            // floorboard
      strut(b, 0, [oo.wheelR + 0.06, 0.25], [ctx.headY - 0.04, ctx.headZ + 0.08], 0.26, 0.06, oo.body); // apron
      b.box(0, oo.seatY - 0.10, oo.seatZ, 0.24, 0.14, oo.seatLen + 0.06, oo.body); // under-seat tail
      if (o.moreExtras) o.moreExtras(b, oo, ctx);
    },
  });
}

const MOTORCYCLES = {
  sport_bike: () => motorcycleBase({
    body: SPORT_RED, barY: 0.90, forkTilt: 0.36,
    extras(b, o, { headY, headZ }) {
      // Fairing wedge over the front + low windscreen.
      tiltBox(b, 0, headY - 0.12, headZ + 0.16, 0.24, 0.30, 0.10, 0.55, o.body);
      tiltBox(b, 0, headY + 0.08, headZ + 0.10, 0.20, 0.14, 0.03, 0.6, WINDSHIELD);
    },
  }),
  race_bike: () => motorcycleBase({
    body: RACE_GREEN, barY: 0.88, forkTilt: 0.36,
    extras(b, o, { headY, headZ }) {
      tiltBox(b, 0, headY - 0.12, headZ + 0.16, 0.24, 0.30, 0.10, 0.55, o.body);
      tiltBox(b, 0, headY + 0.07, headZ + 0.10, 0.20, 0.12, 0.03, 0.6, WINDSHIELD);
      // Number plate: white board on the nose (the racing read).
      tiltBox(b, 0, headY - 0.10, headZ + 0.22, 0.16, 0.16, 0.02, 0.55, PLATE_WHITE);
    },
  }),
  dirt_bike: () => motorcycleBase({
    body: DIRT_ORANGE, wheelR: 0.32, wheelW: 0.11, seg: 8, barY: 1.05,
    seatY: 0.82, tankY: 0.88, forkTilt: 0.30,
    extras(b, o, { headY, headZ }) {
      // High mudguards well clear of the knobby wheels.
      tiltBox(b, 0, o.wheelR + 0.24, o.frontZ + 0.05, 0.16, 0.04, 0.42, 0.15, o.body);
      b.box(0, o.seatY + 0.02, o.rearZ + 0.02, 0.15, 0.05, 0.40, o.body);
    },
  }),
  cruiser_bike: () => motorcycleBase({
    body: CRUISER_BLUE, wheelR: 0.28, wheelW: 0.12, rearZ: -0.68, frontZ: 0.68,
    barY: 1.02, seatY: 0.62, seatZ: -0.30, seatLen: 0.50, tankY: 0.72,
    extras(b, o) {
      // Deep rear fender hugging the wheel + twin chrome pipes.
      b.box(0, o.wheelR + 0.20, o.rearZ, 0.16, 0.08, 0.44, o.body);
      b.box(-0.12, o.wheelR - 0.02, -0.15, 0.07, 0.07, 0.6, CHROME);
    },
  }),
  chopper_bike: () => motorcycleBase({
    body: CHOPPER_BLACK, frontZ: 0.85, rearZ: -0.55, forkTilt: 0.72,
    barY: 1.15, seatY: 0.58, seatZ: -0.28, tankY: 0.68, tankZ: -0.02,
    extras(b, o, { headZ }) {
      // Ape-hanger risers: the tall twin bars ARE the chopper silhouette.
      for (const x of [-0.16, 0.16]) b.box(x, o.barY - 0.14, headZ - 0.02, 0.045, 0.30, 0.045, CHROME);
    },
  }),
  police_bike: () => motorcycleBase({
    body: POLICE_WHITE, barY: 1.0,
    extras(b, o, { headY, headZ }) {
      b.box(0, o.tankY + 0.02, o.tankZ, 0.22, 0.06, 0.38, POLICE_BLUE);      // tank stripe
      tiltBox(b, 0, headY + 0.16, headZ + 0.04, 0.30, 0.26, 0.03, 0.25, WINDSHIELD);
      b.box(-0.06, o.barY + 0.08, headZ - 0.02, 0.1, 0.06, 0.06, LIGHT_RED); // light bar
      b.box(0.06, o.barY + 0.08, headZ - 0.02, 0.1, 0.06, 0.06, LIGHT_BLUE);
      for (const x of [-0.17, 0.17]) b.box(x, o.seatY - 0.14, o.rearZ + 0.05, 0.12, 0.20, 0.30, POLICE_WHITE); // panniers
    },
  }),
  scooter: () => scooterBase({ body: SCOOTER_TEAL }),
  moped: () => scooterBase({
    body: MOPED_CREAM, wheelR: 0.23, wheelW: 0.06, rearZ: -0.52, frontZ: 0.52,
    moreExtras(b) {
      // Pedals on a crank — the moped-not-scooter read.
      b.box(-0.14, 0.16, 0.06, 0.05, 0.03, 0.10, ENGINE_GRAY);
      b.box(0.14, 0.16, -0.02, 0.05, 0.03, 0.10, ENGINE_GRAY);
    },
  }),
  delivery_bike: () => scooterBase({
    body: DELIVERY_ORANGE,
    moreExtras(b, o) {
      // The big top-box IS the delivery read.
      b.box(0, o.seatY + 0.16, o.rearZ - 0.06, 0.34, 0.32, 0.34, BOX_BROWN);
    },
  }),
  mini_bike: () => motorcycleBase({
    body: MINI_YELLOW, wheelR: 0.16, wheelW: 0.12, seg: 8,
    rearZ: -0.34, frontZ: 0.34, barY: 0.78, seatY: 0.48, seatZ: -0.16,
    seatLen: 0.28, tankY: 0.54, tankZ: 0.04, forkTilt: 0.25,
  }),
};

/** Kenney character-b re-skinned into the new "kabaddi" kit — shared verbatim
 *  by kho_kho_player too (PRD: both sports read as the same sleeveless-vest
 *  silhouette, so no separate kit is needed). Factored out of
 *  buildFootballers()/buildCricketer()'s identical download-unzip-retexture
 *  steps so a third and fourth re-skin don't re-download the same zip. */
async function buildReskin(name, kit) {
  await mkdir(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, BLOCKY_ZIP_URL.split('/').pop());
  if (!existsSync(zipPath)) {
    console.log(`  ↓ ${BLOCKY_ZIP_URL}`);
    await download(BLOCKY_ZIP_URL, zipPath);
  }
  const stage = join(cacheDir, 'footballer-src');
  await mkdir(stage, { recursive: true });
  execFileSync('unzip', ['-o', '-j', zipPath, BLOCKY_GLB, BLOCKY_TEXTURE, '-d', stage], { stdio: 'pipe' });
  const dir = join(outRoot, name);
  await mkdir(join(dir, 'Textures'), { recursive: true });
  await copyFile(join(stage, 'character-b.glb'), join(dir, 'raw.glb'));
  execFileSync('python3', [
    join(repo, 'scripts/retexture-footballer.py'),
    join(stage, 'texture-b.png'),
    join(dir, 'Textures/texture-b.png'),
    kit,
  ], { stdio: 'inherit' });
  console.log(`✓ ${name}: character-b + ${kit} kit atlas → assets-src/models/${name}/`);
}

// ── main ────────────────────────────────────────────────────────────────────

await mkdir(outRoot, { recursive: true });
await writeGlb('soccer_ball', soccerBall());
await writeGlb('soccer_goal', soccerGoal());
await writeGlb('battle_top', battleTop(TOP_RED));
await writeGlb('blade_top', battleTop(TOP_BLUE));
await buildFootballers();
await writeGlb('cricket_bat', cricketBat());
await writeGlb('cricket_ball', cricketBall());
await writeGlb('wicket', wicket());
await writeGlb('cricket_pitch', cricketPitch());
await writeGlb('sight_screen', sightScreen());
await buildCricketer();

await writeGlb('kabaddi_mat', kabaddiMat());
await writeGlb('carrom_board', carromBoard());
await writeGlb('carrom_striker', carromStriker());
await writeGlb('carrom_coin_white', carromCoinWhite());
await writeGlb('carrom_coin_black', carromCoinBlack());
await writeGlb('carrom_queen', carromQueen());
await writeGlb('kho_kho_pole', khoKhoPole());
await writeGlb('kho_kho_lane_field', khoKhoLaneField());
await writeGlb('badminton_racket', badmintonRacket());
await writeGlb('shuttlecock', shuttlecock());
await writeGlb('badminton_net', badmintonNet());
await writeGlb('ludo_board', ludoBoard());
await writeGlb('ludo_dice', ludoDice());
await writeGlb('ludo_pawn_red', ludoPawn(PAWN_RED));
await writeGlb('ludo_pawn_green', ludoPawn(PAWN_GREEN));
await writeGlb('ludo_pawn_yellow', ludoPawn(PAWN_YELLOW));
await writeGlb('ludo_pawn_blue', ludoPawn(PAWN_BLUE));
await writeGlb('marble', marble());
await writeGlb('marble_blue', marbleBlue());
await writeGlb('marble_green', marbleGreen());
await buildReskin('kabaddi_player', 'kabaddi');
await buildReskin('kho_kho_player', 'kabaddi');

for (const [name, build] of Object.entries(MOTORCYCLES)) await writeGlb(name, build());

console.log('✓ all first-party sources written — run scripts/vendor-models.mjs next');
