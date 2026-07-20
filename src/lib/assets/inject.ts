// Turns a generated game's asset markers into immutable asset-host URLs
// (PRD-3D-GAMES-AND-ASSETS §5b, Part I "Injection (simplified)"). String
// concatenation ONLY — the injector never reads files and never touches the
// network, which structurally eliminates the Phase-0 failure class (a runtime
// read of a bundle the deploy didn't ship killed every 3D game in prod,
// BUG-FIX-LOG 2026-07-08). The manifest arrives as a static JSON import
// (bundled into .next at build time — nothing to ship separately).

import "server-only";
import type { AssetEntry, AssetManifest } from "./manifest";
import manifestJson from "./manifest.json";
import { THREE_MARKER, MODELS_MARKER_RE, AUDIO_MARKER_RE } from "./markers";

// Markers are defined in ./markers (pure, non-server) so the edit-patch
// reconciliation can share them without importing this server-only module.
// Re-exported here for existing importers (prompt-catalog + inject tests).
export { THREE_MARKER } from "./markers";

/** Per-game first-load transfer cap, cold cache (PRD §8, Decision J). */
export const FIRST_LOAD_BUDGET_BYTES = 2_000_000;

/** Per-game audio cap (PRD §8, Decision J). */
export const AUDIO_BUDGET_BYTES = 500_000;

export interface InjectResult {
  html: string;
  /** Every asset-host URL this game now references — the publish-time
   *  reference ledger (PRD §5b): "forever" as an enumerable, testable set. */
  referencedUrls: string[];
  /** Marker names that did NOT make it into the game: unknown to the
   *  manifest, or dropped to hold the first-load budget. Fail-soft — the
   *  game ships without them; the route logs the list. */
  dropped: string[];
}

/** Inserts markup as early as possible (mirrors game-console.ts's placement
 *  rule) so the game's own `<script type="module">` can resolve its imports. */
function insertEarly(html: string, markup: string): string {
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

function parseNames(html: string, re: RegExp): string[] {
  const names: string[] = [];
  for (const m of html.matchAll(re)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim().toLowerCase();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** The runtime helper 3D games call: resolves a catalog name via AR_ASSETS,
 *  loads the GLB with GLTFLoader + meshopt (models are meshopt-compressed),
 *  and NEVER throws — a failed model leaves the game running without that
 *  entity (§5 fail-soft floor). Returns the scene Object3D with .animations
 *  riding on it, or null. */
function loadModelHelper(): string {
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
function audioHelper(): string {
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
 * Resolves the game's asset markers: USES_THREE and/or USES_MODELS become an
 * import map on the engine's immutable URL (models imply the engine — the
 * loader lives in it) plus, for models, the AR_ASSETS table + loadModel
 * helper. Unmarked games pass through byte-identical — published games are
 * permanent static files and most are plain 2D.
 *
 * Budget (Decision J): referenced bytes are summed at inject time; a model
 * that would push the cold first load past 2 MB is dropped fail-soft.
 *
 * Throws when an engine is needed but the manifest has none: the route's
 * serve-raw fallback catches it and the kid still gets their game (P-class).
 */
export function injectAssets(html: string, manifest: AssetManifest = manifestJson as AssetManifest): InjectResult {
  const wantsThree = html.includes(THREE_MARKER);
  const modelNames = parseNames(html, MODELS_MARKER_RE);
  const audioNames = parseNames(html, AUDIO_MARKER_RE);
  if (!wantsThree && modelNames.length === 0 && audioNames.length === 0) {
    return { html, referencedUrls: [], dropped: [] };
  }

  // Models imply the engine (the loader lives in it); audio alone does not.
  const needsEngine = wantsThree || modelNames.length > 0;
  const engine = needsEngine ? manifest.assets.find((a) => a.type === "engine") : undefined;
  if (needsEngine && !engine) throw new Error("manifest has no engine entry — run scripts/vendor-three.mjs --upload");

  const modelsByName = new Map(manifest.assets.filter((a) => a.type === "model").map((a) => [a.name, a]));
  const audioByName = new Map(manifest.assets.filter((a) => a.type === "sfx" || a.type === "music").map((a) => [a.name, a]));

  const dropped: string[] = [];
  let firstLoadBytes = engine?.bytes ?? 0;

  const models: AssetEntry[] = [];
  for (const name of modelNames) {
    const entry = modelsByName.get(name);
    if (!entry) {
      dropped.push(name);
      continue;
    }
    if (firstLoadBytes + entry.bytes > FIRST_LOAD_BUDGET_BYTES) {
      dropped.push(name); // budget holds; the game ships without this one
      continue;
    }
    firstLoadBytes += entry.bytes;
    models.push(entry);
  }

  const audio: AssetEntry[] = [];
  let audioBytes = 0;
  for (const name of audioNames) {
    const entry = audioByName.get(name);
    if (!entry) {
      dropped.push(name);
      continue;
    }
    if (audioBytes + entry.bytes > AUDIO_BUDGET_BYTES || firstLoadBytes + entry.bytes > FIRST_LOAD_BUDGET_BYTES) {
      dropped.push(name);
      continue;
    }
    audioBytes += entry.bytes;
    firstLoadBytes += entry.bytes;
    audio.push(entry);
  }

  let out = html.split(THREE_MARKER).join("").replace(MODELS_MARKER_RE, "").replace(AUDIO_MARKER_RE, "");

  let markup = "";
  if (engine) {
    markup += `<script type="importmap">${JSON.stringify({ imports: { three: engine.url } })}</script>`;
  }
  const table = Object.fromEntries([...models, ...audio].map((a) => [a.name, a.url]));
  if (modelNames.length > 0 || audioNames.length > 0) {
    markup += `<script>window.AR_ASSETS=${JSON.stringify(table)};</script>`;
  }
  if (modelNames.length > 0) markup += loadModelHelper();
  if (audioNames.length > 0) markup += audioHelper();
  out = insertEarly(out, markup);

  return {
    html: out,
    referencedUrls: [...(engine ? [engine.url] : []), ...models.map((m) => m.url), ...audio.map((a) => a.url)],
    dropped,
  };
}
