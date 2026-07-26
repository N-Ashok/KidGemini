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

// ── main ────────────────────────────────────────────────────────────────────

await mkdir(outRoot, { recursive: true });
await writeGlb('soccer_ball', soccerBall());
await writeGlb('soccer_goal', soccerGoal());
await writeGlb('battle_top', battleTop(TOP_RED));
await writeGlb('blade_top', battleTop(TOP_BLUE));
await buildFootballers();
console.log('✓ all first-party sources written — run scripts/vendor-models.mjs next');
