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

/** The runtime helper 3D games call: resolves a catalog name via AR_ASSETS,
 *  loads the GLB with GLTFLoader + meshopt (models are meshopt-compressed),
 *  and NEVER throws — a failed model leaves the game running without that
 *  entity (§5 fail-soft floor). Returns the scene Object3D with .animations
 *  riding on it, or null.
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
  const __arLoader = new GLTFLoader();
__arLoader.setMeshoptDecoder(MeshoptDecoder);
window.__arPerf = window.__arPerf || { models: {}, rootNames: new WeakMap(), animatedRoots: new WeakSet(), renderer: null };
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
window.loadModel = async function (name) {
  try {
    const url = (window.AR_ASSETS || {})[name];
    if (!url) { console.warn("[ariantra] unknown model:", name); return null; }
    const gltf = await __arLoader.loadAsync(url);
    const obj = gltf.scene;
    obj.animations = gltf.animations || [];
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
