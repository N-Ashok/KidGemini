// Pure asset-runtime helpers (NOT server-only): the marker placement rule and
// the injected <script> helpers. Extracted from inject.ts so the client-side
// preview floor (ensure-runtime.ts) and the server injector (inject.ts) share
// ONE source of truth for the loadModel helper — the two can never drift.

/** Inserts markup as early as possible (right after <head>, else <html>) so a
 *  game's own `<script type="module">` and the import map that resolves it come
 *  before any module load begins. */
export function insertEarly(html: string, markup: string): string {
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = headMatch.index! + headMatch[0].length;
    return html.slice(0, idx) + markup + html.slice(idx);
  }
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const idx = htmlMatch.index! + htmlMatch[0].length;
    return html.slice(0, idx) + markup + html.slice(idx);
  }
  return markup + html;
}

// The injected asset-table script blocks (`<script>window.AR_ASSETS={...};</script>`).
// Shared by inject.ts (edit turns echo the previous injection back — BUG-FIX-LOG
// 2026-08-06, the Sky Patrol bikes) and ensure-runtime.ts (the preview-render
// floor that heals already-stored games). Non-greedy to the first `</script>`:
// the table script never contains a nested close tag (it's JSON of asset URLs).
const arAssetsBlockRe = () => /<script[^>]*>\s*window\.AR_ASSETS\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g;

/** Every parseable AR_ASSETS table in the document, in document order.
 *  Unparseable blocks are skipped (never thrown on) — a kid's game must
 *  survive anything. */
export function parseAssetTables(html: string): Array<Record<string, string>> {
  const tables: Array<Record<string, string>> = [];
  for (const m of html.matchAll(arAssetsBlockRe())) {
    try {
      const parsed: unknown = JSON.parse(m[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        tables.push(parsed as Record<string, string>);
      }
    } catch {
      /* not our block shape — leave it to the strip's own regex miss */
    }
  }
  return tables;
}

/** Removes every AR_ASSETS table block. Callers re-emit exactly one. */
export function stripAssetTables(html: string): string {
  return html.replace(arAssetsBlockRe(), "");
}

/** How many AR_ASSETS table blocks the document carries. */
export function countAssetTables(html: string): number {
  return [...html.matchAll(arAssetsBlockRe())].length;
}

// The injected model-SIZE table (`<script>window.AR_SIZES={...};</script>`),
// added 2026-08-08 for the fragmented-track bug (BUG-FIX-LOG): the measured
// metres of every model the game uses, so `modelSize(name)` can answer with a
// real footprint instead of the game guessing a spacing.
//
// A SEPARATE table rather than richer AR_ASSETS values, deliberately. Folding
// sizes in as `{name: {url, size}}` looks tidier and breaks four things: this
// family of regexes is non-greedy to the first `}`, so a nested object
// truncates the capture and parseAssetTables silently returns [] — which is
// precisely the duplicate-table blindness of the 2026-08-06 Sky Patrol bug;
// loadModel/playSound index the table for a URL string; ensure-runtime's
// idempotence check compares values with === and would re-emit on every render;
// and already-published games are immutable, so their loadModel would hand an
// object to loadAsync forever. Array values keep the same shape guarantee the
// URL strings had: no `}` inside a value.
const arSizesBlockRe = () => /<script[^>]*>\s*window\.AR_SIZES\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g;

/** Every parseable AR_SIZES table in the document, in document order.
 *  Unparseable blocks are skipped, never thrown on — same fail-soft floor as
 *  parseAssetTables: a kid's game must survive anything. */
export function parseSizeTables(html: string): Array<Record<string, [number, number, number]>> {
  const tables: Array<Record<string, [number, number, number]>> = [];
  for (const m of html.matchAll(arSizesBlockRe())) {
    try {
      const parsed: unknown = JSON.parse(m[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        tables.push(parsed as Record<string, [number, number, number]>);
      }
    } catch {
      /* not our block shape — leave it to the strip's own regex miss */
    }
  }
  return tables;
}

/** Removes every AR_SIZES table block. Callers re-emit exactly one. */
export function stripSizeTables(html: string): string {
  return html.replace(arSizesBlockRe(), "");
}

/** How many AR_SIZES table blocks the document carries. */
export function countSizeTables(html: string): number {
  return [...html.matchAll(arSizesBlockRe())].length;
}

// The injected path-AXIS table (`<script>window.AR_AXES={...};</script>`),
// added 2026-08-08 for the poorly-formed-track bug (BUG-FIX-LOG). Separate
// from AR_SIZES for the same four reasons AR_SIZES is separate from AR_ASSETS
// (see above) — chiefly that these regexes are non-greedy to the first `}`,
// so nesting silently truncates the capture. Values are plain strings, so no
// `}` can ever appear inside one.
const arAxesBlockRe = () => /<script[^>]*>\s*window\.AR_AXES\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g;

/** Every parseable AR_AXES table in the document, in document order. */
export function parseAxisTables(html: string): Array<Record<string, string>> {
  const tables: Array<Record<string, string>> = [];
  for (const m of html.matchAll(arAxesBlockRe())) {
    try {
      const parsed: unknown = JSON.parse(m[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        tables.push(parsed as Record<string, string>);
      }
    } catch {
      /* not our block shape — fail soft, same floor as parseSizeTables */
    }
  }
  return tables;
}

/** Removes every AR_AXES table block. Callers re-emit exactly one. */
export function stripAxisTables(html: string): string {
  return html.replace(arAxesBlockRe(), "");
}

/** How many AR_AXES table blocks the document carries. */
export function countAxisTables(html: string): number {
  return [...html.matchAll(arAxesBlockRe())].length;
}

// The injected tile-EDGE table (`<script>window.AR_EDGES={...};</script>`),
// added 2026-08-09 for the SECOND poorly-formed-track bug (BUG-FIX-LOG).
// AR_AXES answers "none" for every corner, which is true and useless — a model
// placing a corner needs to know WHICH EDGES it joins.
//
// LAZY, exactly like AR_SIZES and AR_AXES. This shipped GREEDY for one day
// (2026-08-09) on the reasoning that AR_EDGES holds NESTED objects, so a lazy
// `\}` would truncate at the first inner brace. That reasoning was wrong, and
// it broke 3D games in production. The match is anchored on `</script>`, NOT on
// `}` — a lazy quantifier keeps expanding until the whole TAIL fits, so it
// necessarily stops at the last `}` inside this block and never at an inner
// one. Greedy, by contrast, ran past this block's own closing tag to the last
// `}`+`</script>` anywhere in the document, deleting the loadModel helper on
// the way ("loadModel is not defined") and capturing markup that then failed
// JSON.parse — silently, into the fail-soft catch, so the table read as absent
// and nothing downstream noticed.
const arEdgesBlockRe = () => /<script[^>]*>\s*window\.AR_EDGES\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g;

/** Every parseable AR_EDGES table in the document, in document order. */
export function parseEdgeTables(html: string): Array<Record<string, unknown>> {
  const tables: Array<Record<string, unknown>> = [];
  for (const m of html.matchAll(arEdgesBlockRe())) {
    try {
      const parsed: unknown = JSON.parse(m[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        tables.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* not our block shape — fail soft, same floor as parseSizeTables */
    }
  }
  return tables;
}

/** Removes every AR_EDGES table block. Callers re-emit exactly one. */
export function stripEdgeTables(html: string): string {
  return html.replace(arEdgesBlockRe(), "");
}

/** How many AR_EDGES table blocks the document carries. */
export function countEdgeTables(html: string): number {
  return [...html.matchAll(arEdgesBlockRe())].length;
}

/** Neutralizes a literal `</script>` inside a string about to be inlined
 *  into an HTML `<script>` block — `<\/script>` is identical to `</script>`
 *  inside a JS string (or JSON, which has no special meaning for a lone
 *  backslash-escaped `/`), but doesn't terminate the surrounding tag early.
 *  Extracted (2026-08-03) from preview-runtime.ts so every module that
 *  inlines arbitrary content into a `<script>` — the preview SDK bundle, a
 *  kid's save-state JSON — shares one escape, rather than drifting copies. */
export function escapeForInlineScript(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1");
}

/** Perf Panel (docs/2026-07-30_PRD_PreviewPerfPanel.md §2): bounds each
 *  named model's tracked-instance array so a game that spawns/despawns the
 *  same model in a loop can't grow window.__arPerf without limit forever —
 *  this is a debug-only telemetry structure that still runs on EVERY preview
 *  render (like the frame governor), so it needs its own small ceiling
 *  (see docs/SCALABILITY_ISSUES.md). Oldest entries are dropped first. */
export const MAX_TRACKED_INSTANCES = 1_000;

/** Pure triangle-sum used by loadModelHelper()'s injected script (duplicated
 *  there as inline JS, same technique perf-probe.ts uses for its bucket
 *  thresholds — the injected copy runs against a REAL three.js Object3D in
 *  the iframe, which this TS function can't be handed directly). Extracted
 *  so the counting algorithm itself gets a real, executable unit test.
 *  Non-indexed geometry (no .index) falls back to attributes.position. */
export function countTriangles(obj: { traverse: (cb: (child: any) => void) => void }): number {
  let triangles = 0;
  obj.traverse((child: any) => {
    if (!child?.isMesh || !child.geometry) return;
    const geo = child.geometry;
    if (geo.index) triangles += geo.index.count / 3;
    else if (geo.attributes?.position) triangles += geo.attributes.position.count / 3;
  });
  return Math.round(triangles);
}

/** Version stamp for the loadModel() helper body (a plain global, not just a
 *  comment, so it survives minification/whitespace-normalization anywhere
 *  between generation and the browser). Bump this whenever loadModelHelper()'s
 *  BEHAVIOR changes — ensureAssetRuntime()'s re-floor guard (ensure-runtime.ts)
 *  compares this against the currently-injected version to decide whether an
 *  already-published game's stale helper needs replacing, not just whether
 *  `window.loadModel` merely exists. See the 2026-08-05 template-cache change:
 *  v1 had no cache; v2 caches the parsed GLTF per model name.
 *  v4 (2026-08-08, BUG-FIX-LOG fragmented race tracks) adds window.modelSize()
 *  over the AR_SIZES table. The bump is what retrofits it onto games ALREADY
 *  stored: ensureAssetRuntime strips the v3 block and injects v4 on the next
 *  preview render, so no migration is needed.
 *  v6 (2026-08-09, BUG-FIX-LOG the second poorly-formed track) adds
 *  window.modelJoins() + window.rotateToJoin() over the AR_EDGES table. As
 *  with v4, the bump IS the migration: ensureAssetRuntime strips the older
 *  block and injects v6 on the next preview render, so every stored 3D game
 *  picks up corner data the moment a child opens it — no restamp campaign.
 *  v7 (2026-08-09) adds window.fitTile(): the rotation for a grid cell given
 *  the directions it must connect. Three rounds of PROMPT teaching failed to
 *  make a generated track rotate its corners correctly (TECH_DEBT #97 — the
 *  fix is not more prose), so the calculation moved into the runtime. */
export const LOAD_MODEL_HELPER_VERSION = 7;

/** The runtime helper 3D games call: resolves a catalog name via AR_ASSETS,
 *  loads the GLB with GLTFLoader + meshopt (models are meshopt-compressed),
 *  and NEVER throws — a failed model leaves the game running without that
 *  entity (§5 fail-soft floor). Returns the scene Object3D with .animations
 *  riding on it, or null.
 *
 *  Template cache (2026-08-05, TECH_DEBT — global 3D slowdown fix; NARROWED
 *  2026-08-05 same day after a live regression report — see v3 note below):
 *  ONLY a STATIC (no-animation) model is cached — its parsed scene is stored
 *  as a pristine, never-scene-graph-attached template, and every call after
 *  the first clones from it with plain .clone() (cheap: shares geometry/
 *  material by reference, which is also what makes loadModelBatch's
 *  InstancedMesh pooling possible on the same cached data).
 *
 *  ANIMATED models are deliberately NEVER cached or cloned — every call does
 *  a fresh GLTFLoader.loadAsync() and hands back that pristine, freshly-
 *  parsed scene untouched (byte-for-byte the pre-2026-08-05 behavior). v2
 *  (same day) tried caching + SkeletonUtils.clone() for animated models too,
 *  on the assumption that SkeletonUtils correctly re-binds any rig — that
 *  assumption was never verified against the real hosted models and turned
 *  out wrong: a live report showed skinned meshes rendering at rest pose
 *  (legs/arms/rotors not moving) on EVERY load, including the very first —
 *  i.e. SkeletonUtils.clone() itself was silently failing to retarget bones
 *  for at least some of these rigs, not just a multi-instance edge case.
 *  Given that risk was never worth the modest win (repeat crowd loads being
 *  slightly cheaper), animated models get zero behavior change from this
 *  whole effort — the .glb bytes are still HTTP-cached by the browser after
 *  the first load, so a repeat load is a re-parse, not a real network round
 *  trip; that was always "good enough" and is the one guaranteed-correct
 *  path. Do not reintroduce SkeletonUtils cloning without first verifying it
 *  against the actual manifest models in a real browser, not just review.
 *
 *  Perf Panel addition (2026-07-30): after a SUCCESSFUL load, records
 *  {name, triangles, instances} into window.__arPerf.models and stamps the
 *  loaded root into window.__arPerf.rootNames (a WeakMap<Object3D, name> —
 *  the key the vendored three bundle's AnimationMixer wrap reads to mark a
 *  root "animated", scripts/vendor-three.mjs). This is wrapped in its OWN
 *  try/catch, separate from the outer load try/catch: a telemetry bug must
 *  never turn into a broken model load (the existing `return null` contract
 *  on a genuine load failure is unchanged — nothing is recorded on that path). */
export function loadModelHelper(): string {
  return `<script type="module">
  import { GLTFLoader, MeshoptDecoder } from "three";
  window.__arLoadModelVersion = ${LOAD_MODEL_HELPER_VERSION};
// modelSize (2026-08-08, the fragmented-track fix): the measured metres a model
// renders at scale 1, available BEFORE loading so a game can plan a layout. The
// "|| {}" guard means order-of-injection never matters, and an unknown or
// skinned model answers null rather than a made-up number — a game that checks
// for null degrades to eyeballing, which is exactly what it did before v4.
window.AR_SIZES = window.AR_SIZES || {};
window.modelSize = function (name) {
  var s = window.AR_SIZES[name];
  return (s && s.length === 3) ? { x: s[0], y: s[1], z: s[2] } : null;
};
// modelAxis (2026-08-08, the poorly-formed-track fix): which axis a PATH
// piece's road runs along at rest — "x", "z", or "none" for a hub/corner. The
// two road kits genuinely disagree (city road_straight runs along X, racing
// race_track_straight along Z) and a 1x1 square tile's size cannot reveal it,
// so before this a game had to guess and got it wrong every time. Unknown
// answers null — then eyeball it, same as before.
window.AR_AXES = window.AR_AXES || {};
window.modelAxis = function (name) {
  var a = window.AR_AXES[name];
  return (a === "x" || a === "z" || a === "none") ? a : null;
};
// modelJoins (2026-08-09, the SECOND poorly-formed-track fix): which edges a
// tile's road actually reaches, measured from a top-down render of the
// published bytes. modelAxis() answers "none" for every corner — true, and
// useless for placing one; with nothing else to reason from, generated tracks
// guessed corner rotations and the curves never met the straights.
//   .joins  ["-x","+z"]  edges the carriageway reaches at rest (no rotation)
//   .lane   0.7          drivable width in METRES at scale 1
//   .at     {"-x":0.5}   where each join sits, in metres from the piece's own
//                        minimum on that edge's axis (matters on 2x2 pieces)
// Unknown answers null — then eyeball it, exactly as before.
window.AR_EDGES = window.AR_EDGES || {};
window.modelJoins = function (name) {
  var e = window.AR_EDGES[name];
  return (e && e.joins && e.joins.length) ? e : null;
};
// rotateToJoin: the one calculation every track needs and no game got right by
// hand. Returns the rotation.y IN RADIANS that carries a piece's "from" edge
// onto the "to" edge — e.g. a corner joining ["+z","+x"] that must instead join
// west and south is rotateToJoin("race_track_corner","+x","+z"). Quarter turns
// only, which is all a square grid can use.
// (No backticks anywhere in this block: it is inlined into a TEMPLATE LITERAL,
// so one would end the helper string mid-function.)
window.rotateToJoin = function (name, from, to) {
  var order = ["-z", "+x", "+z", "-x"]; // clockwise seen from above
  var a = order.indexOf(from), b = order.indexOf(to);
  if (a < 0 || b < 0) return 0;
  return ((b - a + 4) % 4) * (Math.PI / 2);
};
// fitTile (2026-08-09): say WHICH DIRECTIONS a grid cell must connect and get
// the rotation.y that makes the piece do it. Added after three rounds of
// teaching failed to land: a generated track chose the right kit and one scale
// factor, then hardcoded all four corner rotations and got all four wrong,
// because working out "this cell needs north and east, the piece joins +z and
// +x at rest, so rotate 3pi/2" is four steps of reasoning under a token budget.
// This is one call. Directions are where the ROAD LEAVES the cell:
//   fitTile("race_track_corner", ["-z", "+x"])   // track to the north and east
// Returns 0 for an unknown piece, and null when no quarter turn can satisfy the
// request — which means the wrong PIECE was chosen (asking a corner to join two
// opposite edges), so a game can detect that instead of silently drawing a gap.
window.fitTile = function (name, need) {
  var e = window.AR_EDGES[name];
  if (!e || !e.joins || !need || !need.length) return 0;
  var order = ["-z", "+x", "+z", "-x"];
  var want = need.slice().sort().join(",");
  for (var q = 0; q < 4; q++) {
    var got = e.joins
      .map(function (j) { return order[(order.indexOf(j) + q) % 4]; })
      .sort()
      .join(",");
    if (got === want) return q * (Math.PI / 2);
  }
  return null;
};
  const __arLoader = new GLTFLoader();
__arLoader.setMeshoptDecoder(MeshoptDecoder);
window.__arPerf = window.__arPerf || { models: {}, rootNames: new WeakMap(), animatedRoots: new WeakSet(), renderer: null };
var __arStaticTemplates = {};
function __arCountTriangles(obj) {
  var triangles = 0;
  obj.traverse(function (child) {
    if (!child.isMesh || !child.geometry) return;
    var geo = child.geometry;
    if (geo.index) triangles += geo.index.count / 3;
    else if (geo.attributes && geo.attributes.position) triangles += geo.attributes.position.count / 3;
  });
  return Math.round(triangles);
}
async function __arLoadFresh(name) {
  const url = (window.AR_ASSETS || {})[name];
  if (!url) { console.warn("[ariantra] unknown model:", name); return null; }
  const gltf = await __arLoader.loadAsync(url);
  return { scene: gltf.scene, animations: gltf.animations || [] };
}
window.loadModel = async function (name) {
  try {
    var obj;
    if (__arStaticTemplates[name]) {
      // Cache only ever holds a STATIC (no-animation) template — see the
      // loadModelHelper() doc comment for why animated models are excluded.
      obj = __arStaticTemplates[name].scene.clone();
      obj.animations = [];
    } else {
      const fresh = await __arLoadFresh(name);
      if (!fresh) return null;
      if (fresh.animations.length) {
        obj = fresh.scene;
        obj.animations = fresh.animations;
      } else {
        __arStaticTemplates[name] = fresh;
        obj = fresh.scene.clone();
        obj.animations = [];
      }
    }
    // Same answer as modelSize(name), riding on the object — so code that
    // already holds the loaded root can size it without re-quoting the name.
    obj.userData.arSize = window.modelSize(name);
    try {
      var __arEntry = window.__arPerf.models[name] || { name: name, triangles: 0, instances: [] };
      __arEntry.triangles = __arCountTriangles(obj);
      __arEntry.instances.push(obj);
      if (__arEntry.instances.length > ${MAX_TRACKED_INSTANCES}) __arEntry.instances.shift();
      window.__arPerf.models[name] = __arEntry;
      window.__arPerf.rootNames.set(obj, name);
    } catch (e) { /* telemetry only — never blocks the load */ }
    return obj;
  } catch (e) {
    console.warn("[ariantra] loadModel failed:", name, e);
    return null;
  }
};
</script>`;
}

/** Bulk-placement counterpart to loadModel(), for static (non-animated)
 *  props placed in large numbers — a forest, a city block, a crowd of
 *  identical rocks. loadModel() called N times still creates N full
 *  Object3D/Mesh subtrees (cheap after the template cache above, but each
 *  is still its own draw call); loadModelBatch(name, count) instead creates
 *  ONE InstancedMesh per distinct geometry/material found in the model and
 *  reuses it for all `count` placements, collapsing N draw calls into ~1
 *  per mesh part.
 *
 *  Deliberately NOT a silent replacement for loadModel()'s return shape:
 *  generated games routinely wrap a loaded model in their own Group and
 *  compute `new Box3().setFromObject(wrap)` for collision (every prop in a
 *  typical city/forest game). An InstancedMesh has no per-instance scene
 *  subtree for Box3 to walk, so this is a SEPARATE, explicitly-named API the
 *  prompt teaches only for bulk static placement — boundsAt(i) is the
 *  supported replacement for Box3.setFromObject in that case. Animated
 *  models are out of scope here (true per-instance skinned-mesh batching
 *  needs a bone-texture approach, not attempted) — always use loadModel()
 *  for anything with animations.
 *
 *  Capacity is fixed at call time (`count`) — no silent unbounded growth of
 *  the underlying InstancedMesh buffers. */
export function loadModelBatchHelper(): string {
  return `<script type="module">
  import { InstancedMesh, Matrix4, Box3, Group, Vector3, Quaternion, Euler } from "three";
window.loadModelBatch = async function (name, count) {
  try {
    if (typeof window.loadModel !== "function") { console.warn("[ariantra] loadModelBatch needs loadModel loaded first"); return null; }
    const template = await (async function () {
      // Piggyback on loadModel's own template cache — reach it via a single
      // real load if nothing has cached this name yet, then discard that
      // instance (its geometry/material are shared with the cache either way).
      const probe = await window.loadModel(name);
      return probe ? { scene: probe, animations: probe.animations || [] } : null;
    })();
    if (!template) return null;
    if (template.animations.length) { console.warn("[ariantra] loadModelBatch does not support animated models:", name); return null; }
    const container = new Group();
    const parts = [];
    template.scene.traverse(function (child) {
      if (!child.isMesh || !child.geometry || !child.material) return;
      parts.push(child);
    });
    const meshes = parts.map(function (part) {
      const im = new InstancedMesh(part.geometry, part.material, count);
      im.count = count;
      container.add(im);
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      return im;
    });
    try {
      var __arTriangles = 0;
      for (var __p = 0; __p < parts.length; __p++) {
        var __geo = parts[__p].geometry;
        if (__geo.index) __arTriangles += __geo.index.count / 3;
        else if (__geo.attributes && __geo.attributes.position) __arTriangles += __geo.attributes.position.count / 3;
      }
      window.__arPerf = window.__arPerf || { models: {} };
      window.__arPerf.batches = window.__arPerf.batches || {};
      window.__arPerf.batches[name] = { name: name, triangles: Math.round(__arTriangles), drawCalls: meshes.length, count: count, roots: [container] };
    } catch (e) { /* telemetry only — never blocks the batch */ }
    var matrix = new Matrix4();
    var box = new Box3();
    var __arPos = new Vector3();
    var __arQuat = new Quaternion();
    var __arEuler = new Euler();
    var __arScale = new Vector3();
    return {
      mesh: container,
      setInstance: function (i, transform) {
        var pos = (transform && transform.position) || {};
        var scl = (transform && transform.scale) || {};
        var rot = (transform && transform.rotation) || {};
        __arPos.set(pos.x || 0, pos.y || 0, pos.z || 0);
        __arEuler.set(rot.x || 0, rot.y || 0, rot.z || 0);
        __arQuat.setFromEuler(__arEuler);
        __arScale.set(scl.x != null ? scl.x : 1, scl.y != null ? scl.y : 1, scl.z != null ? scl.z : 1);
        matrix.compose(__arPos, __arQuat, __arScale);
        for (var m = 0; m < meshes.length; m++) {
          meshes[m].setMatrixAt(i, matrix);
          meshes[m].instanceMatrix.needsUpdate = true;
        }
      },
      boundsAt: function (i) {
        if (!parts.length) return new Box3();
        meshes[0].getMatrixAt(i, matrix);
        box.copy(parts[0].geometry.boundingBox).applyMatrix4(matrix);
        return box;
      },
    };
  } catch (e) {
    console.warn("[ariantra] loadModelBatch failed:", name, e);
    return null;
  }
};
</script>`;
}

/** One line of the art-credits chip: what to show and where it links. */
export interface CreditLine {
  /** Catalog name, shown human-readably (underscores become spaces). */
  name: string;
  author: string;
  sourceUrl: string;
}

/** The art-credits chip (owner decision 2026-08-06, motorcycle batch): games
 *  that use a CC-BY model get a small fixed "🎨 art" chip that expands into
 *  the credit lines the license requires (title, author, source link, license
 *  name). Injected mechanically by inject.ts — never left to the LLM or the
 *  kid to remember — so the preview shows it while making and every published
 *  copy carries it. Plain script, no framework, fails soft: if the DOM calls
 *  throw (e.g. a game that nukes document.body), the game itself is untouched. */
export function creditsHelper(credits: CreditLine[]): string {
  const payload = escapeForInlineScript(JSON.stringify(credits));
  return `<script>
(function () {
  function mount() {
    try {
      var credits = ${payload};
      if (!credits.length || document.getElementById("ar-credits")) return;
      var chip = document.createElement("div");
      chip.id = "ar-credits";
      chip.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;font:11px/1.4 system-ui,sans-serif;";
      var btn = document.createElement("button");
      btn.textContent = "\\uD83C\\uDFA8 art";
      btn.setAttribute("aria-label", "Art credits");
      btn.style.cssText = "border:0;border-radius:10px;padding:3px 8px;background:rgba(0,0,0,.45);color:#fff;cursor:pointer;font:inherit;";
      var panel = document.createElement("div");
      panel.style.cssText = "display:none;margin-top:4px;background:rgba(0,0,0,.75);color:#fff;border-radius:8px;padding:6px 10px;max-width:75vw;";
      for (var i = 0; i < credits.length; i++) {
        var c = credits[i], row = document.createElement("div");
        var a = document.createElement("a");
        a.href = c.sourceUrl; a.target = "_blank"; a.rel = "noopener";
        a.style.cssText = "color:#9cf;text-decoration:underline;";
        a.textContent = "\\"" + c.name.replace(/_/g, " ") + "\\" by " + c.author;
        row.appendChild(a);
        row.appendChild(document.createTextNode(" (CC BY 3.0)"));
        panel.appendChild(row);
      }
      btn.addEventListener("click", function () {
        panel.style.display = panel.style.display === "none" ? "block" : "none";
      });
      chip.appendChild(btn); chip.appendChild(panel);
      document.body.appendChild(chip);
    } catch (e) { /* credits must never break a game */ }
  }
  if (document.body) mount();
  else addEventListener("DOMContentLoaded", mount);
})();
</script>`;
}

/** playSound / playMusic (PRD §5b, §10b R2). Web Audio ONLY — no <audio>
 *  element: MP3 encoders add priming/padding samples, so element-level
 *  looping gaps/clicks at every restart; the helper decodes the buffer and
 *  loops an AudioBufferSourceNode between silence-trimmed loop points.
 *  Autoplay policy: the context resumes on the first tap/keypress. Every
 *  path fails soft — a broken sound is a silent one, never a broken game. */
export function audioHelper(): string {
  return `<script>
(function () {
  var ctx = null, buffers = {}, currentMusic = null;
  function context() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      var resume = function () { if (ctx.state === "suspended") ctx.resume(); };
      addEventListener("pointerdown", resume, true);
      addEventListener("keydown", resume, true);
    }
    return ctx;
  }
  function load(name) {
    var url = (window.AR_ASSETS || {})[name];
    if (!url) { console.warn("[ariantra] unknown sound:", name); return Promise.resolve(null); }
    if (!buffers[name]) {
      buffers[name] = fetch(url)
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) {
          return new Promise(function (res, rej) { context().decodeAudioData(ab, res, rej); });
        })
        .catch(function (e) { console.warn("[ariantra] sound failed:", name, e); return null; });
    }
    return buffers[name];
  }
  function trimBounds(buf) {
    var d = buf.getChannelData(0), t = 0.001, s = 0, e = d.length - 1;
    while (s < e && Math.abs(d[s]) < t) s++;
    while (e > s && Math.abs(d[e]) < t) e--;
    return { start: s / buf.sampleRate, end: (e + 1) / buf.sampleRate };
  }
  window.playSound = function (name) {
    try {
      load(name).then(function (buf) {
        if (!buf) return;
        var src = context().createBufferSource();
        src.buffer = buf;
        src.connect(context().destination);
        src.start();
      });
    } catch (e) { /* a silent effect, never a broken game */ }
  };
  window.playMusic = function (name) {
    var handle = { stop: function () {} };
    try {
      if (currentMusic) { try { currentMusic.stop(); } catch (e2) {} currentMusic = null; }
      load(name).then(function (buf) {
        if (!buf) return;
        var src = context().createBufferSource();
        src.buffer = buf;
        var b = trimBounds(buf);
        src.loop = true;
        src.loopStart = b.start;
        src.loopEnd = b.end;
        var gain = context().createGain();
        gain.gain.value = 0.5;
        src.connect(gain);
        gain.connect(context().destination);
        src.start(0, b.start);
        currentMusic = src;
        handle.stop = function () { try { src.stop(); } catch (e3) {} if (currentMusic === src) currentMusic = null; };
      });
    } catch (e) { /* silent */ }
    return handle;
  };
})();
</script>`;
}

/**
 * The frame governor (2026-07-29). Injected by ensureAssetRuntime into every
 * 3D/asset game, which is the ONLY thing that reaches games that already
 * exist: the playbook's pause/frame-cap rules are written into fresh builds,
 * but an edit is a minimal SEARCH/REPLACE patch, so it never retrofits a loop
 * the child didn't ask about. Owner report that prompted this: a device
 * heating up after an hour in the preview.
 *
 * Two jobs: skip work while the page is hidden, and cap to ~60fps (a 120Hz
 * ProMotion Mac/iPad otherwise does double the work for no visible gain — and
 * any game that moves per-frame rather than per-second literally runs twice as
 * fast there). Owner decision 2026-07-29: 60 is the cap.
 *
 * Every design choice here is about failing SAFE on ~200 games we can no
 * longer test individually:
 *  - a skipped frame ALWAYS re-requests, so the chain can never die;
 *  - throttling is keyed per callback via a WeakMap, so a game running two
 *    independent loops keeps both (a single shared timestamp would let the
 *    first starve the second);
 *  - a callback we cannot key (a fresh arrow each frame) is simply never
 *    throttled — the fallback is "no saving", never "no frames";
 *  - it does NOT pause on blur/occlusion, only on document.hidden, which is
 *    what browsers already do — so it introduces no new resume-delta
 *    behaviour for old games that lack a delta clamp.
 */
export function frameGovernor(): string {
  return `<script>(function(){
if (window.__arFrameGovernor) return;
window.__arFrameGovernor = 1;
var raf = window.requestAnimationFrame.bind(window);
var seen = new WeakMap();
window.requestAnimationFrame = function (cb) {
  return raf(function (t) {
    // Skipped frames ALWAYS re-request through the wrapper, so the loop can
    // never die — that is the one failure mode that would break a live game.
    if (document.hidden) { window.requestAnimationFrame(cb); return; }
    var prev = (typeof cb === 'function' ? seen.get(cb) : 0) || 0;
    if (prev && t - prev < 15) { window.requestAnimationFrame(cb); return; }
    if (typeof cb === 'function') seen.set(cb, t);
    return cb(t);
  });
};
})();</script>`;
}

/**
 * The WebGL context guard (2026-08-10).
 *
 * Shadow verify puts a SECOND live 3D document on the page during every edit,
 * and preview iframes are discarded and recreated as a child keeps editing. A
 * browser caps how many WebGL contexts it will keep; past the cap it silently
 * drops the OLDEST — which is the game the child is playing. The owner's
 * recording is exactly that signature: the HUD keeps its state (Strength 900
 * before AND during the edit, so the document was never reloaded) while the
 * canvas empties, and it returns when the edit ends and the second document
 * goes away.
 *
 * Two gaps, both of which this closes, and both of which apply to the ~200
 * games that already exist — which is why it rides ensureAssetRuntime rather
 * than the playbook:
 *
 *  1. Context loss is PERMANENT unless the page calls preventDefault() on the
 *     `webglcontextlost` event. We never did, so an evicted game stayed blank
 *     forever instead of coming back. three.js already re-uploads its
 *     resources on `webglcontextrestored`; it just never got the chance.
 *  2. A discarded iframe's context is released whenever GC gets round to it,
 *     so contexts pile up across a long editing session until something is
 *     evicted — and the oldest context on the page is the child's game. The
 *     owner's 2026-08-10 console paste shows ELEVEN edits in one sitting
 *     before the blue appeared, which is that pile-up, not a single bad edit.
 *     Each round is released explicitly instead: the parent posts
 *     `{__ari:'release-gl'}` immediately before it unmounts the shadow frame.
 *     `pagehide` is kept as a backstop only — Chrome does not reliably fire it
 *     for a detached iframe, which is exactly how every round ends.
 *
 * getContext is patched rather than the canvas queried, because the canvas
 * usually does not exist yet when this runs — the same reason the frame
 * governor patches requestAnimationFrame.
 */
export function webglContextGuard(): string {
  return `<script>(function(){
if (window.__arGlGuard) return;
window.__arGlGuard = 1;
var get = HTMLCanvasElement.prototype.getContext;
var live = [];
var lostCount = 0;
HTMLCanvasElement.prototype.getContext = function (type) {
  var ctx = get.apply(this, arguments);
  try {
    if (ctx && /webgl/i.test(String(type)) && !this.__arGlGuarded) {
      this.__arGlGuarded = 1;
      live.push(ctx);
      this.addEventListener('webglcontextlost', function (e) {
        // THE line that matters: without preventDefault the loss is final and
        // the canvas stays blank for the rest of the document's life.
        e.preventDefault();
        lostCount++;
        console.warn('[ari] WebGL context lost — restore requested');
      }, false);
      this.addEventListener('webglcontextrestored', function () {
        if (lostCount > 0) lostCount--;
        console.warn('[ari] WebGL context restored');
      }, false);
    }
  } catch (e) { /* never break getContext */ }
  return ctx;
};
// Restoring the CONTEXT is not enough — the game's LOOP must survive to see
// it. While a context is lost, three.js's renderer throws mid-render (the GL
// introspection APIs return null, and three calls .trim() on the result —
// the exact stack the harness attributed on 2026-08-10). Games request their
// next frame AFTER rendering (three's setAnimationLoop does too), so that
// throw kills the loop for good: the context comes back, nothing draws, the
// canvas stays blank, and no click can restart it. So: while any tracked
// context is lost, hold rAF callbacks — always re-request, never run — the
// same shape as the frame governor's document.hidden skip, and it resumes by
// itself on webglcontextrestored. Composes with the governor's own wrapper
// (this one runs outside it) — worst case a held frame is re-queued twice.
var raf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = function (cb) {
  return raf(function (t) {
    if (lostCount > 0) { window.requestAnimationFrame(cb); return; }
    return cb(t);
  });
};
function release(why) {
  // Hand the GPU back now rather than at GC, so the next preview iframe does
  // not push the page over the context cap.
  for (var i = 0; i < live.length; i++) {
    try {
      var ext = live[i].getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch (e) { /* already gone */ }
  }
  live.length = 0;
  // Observable from the parent page: this is how the harness proves the round
  // was ASKED to release at unmount, rather than assuming it.
  console.warn('[ari] WebGL contexts released (' + why + ')');
}
// Lets the harness assert that a torn-down round actually gave its context
// back, instead of assuming pagehide fired.
Object.defineProperty(window, '__arGlCount', { get: function () { return live.length; } });
// The parent asks explicitly, immediately before it unmounts this frame.
// pagehide alone is NOT enough: Chrome does not reliably fire it when an
// iframe is detached from the DOM, which is precisely how every shadow round
// ends — so without this the contexts pile up exactly as they did in the
// owner's eleven-edit session.
addEventListener('message', function (e) {
  var d = e && e.data;
  if (d && d.__ari === 'release-gl') release('asked');
}, false);
addEventListener('pagehide', function () { release('pagehide'); });
})();</script>`;
}
