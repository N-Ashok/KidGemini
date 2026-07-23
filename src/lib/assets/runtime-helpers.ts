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

/** The runtime helper 3D games call: resolves a catalog name via AR_ASSETS,
 *  loads the GLB with GLTFLoader + meshopt (models are meshopt-compressed),
 *  and NEVER throws — a failed model leaves the game running without that
 *  entity (§5 fail-soft floor). Returns the scene Object3D with .animations
 *  riding on it, or null. */
export function loadModelHelper(): string {
  return `<script type="module">
  import { GLTFLoader, MeshoptDecoder } from "three";
  const __arLoader = new GLTFLoader();
__arLoader.setMeshoptDecoder(MeshoptDecoder);
window.loadModel = async function (name) {
  try {
    const url = (window.AR_ASSETS || {})[name];
    if (!url) { console.warn("[ariantra] unknown model:", name); return null; }
    const gltf = await __arLoader.loadAsync(url);
    const obj = gltf.scene;
    obj.animations = gltf.animations || [];
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
