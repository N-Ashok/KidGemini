// Preview Perf Panel — the debug-only per-model load probe
// (docs/2026-07-30_PRD_PreviewPerfPanel.md). Same shape as preview-verify.ts:
// pure, no DOM, no React. Unlike preview-verify.ts (which posts raw evidence
// and lets the PARENT classify it), the probe here computes the bucket
// itself before posting — there's no judgment call to defer, just a live
// snapshot for the debug tab to render.
//
// The hard part (PRD §2): the renderer/scene/AnimationMixers are private
// variables inside the generated game's own module script. Two additive
// wraps in the vendored three.js bundle (scripts/vendor-three.mjs) register
// the live WebGLRenderer instance and which Object3D roots are animated onto
// window.__arPerf; runtime-helpers.ts's loadModel() records each named
// model's triangle count and live instances into the same registry. This
// probe just reads it once a second.

import { PERF_PROBE_SOURCE, PARENT_READY_SOURCE } from "../preview-messages";
import { insertEarly } from "./runtime-helpers";
import type { LoadBucket } from "@/types/preview-perf.types";

export { PERF_PROBE_SOURCE };

/** Owner decision 2026-07-30: colour is by LOAD, not "cost" — "cost" implies
 *  money, this is compute load. load = triangles × live instance count × an
 *  animated multiplier (an actively-animated mesh costs more per frame than
 *  a static one sharing the same draw call). Thresholds are an initial
 *  calibration, not a measured ceiling — see docs/SCALABILITY_ISSUES.md for
 *  the "revisit when" trigger once more generated games are observed. */
export const ANIMATED_LOAD_MULTIPLIER = 2;
export const LOAD_GREEN_MAX = 20_000;
export const LOAD_YELLOW_MAX = 150_000;

/** How often the injected probe samples + posts (ms). */
export const PERF_SAMPLE_MS = 1_000;

/** Version stamp for the injected probe script body, same retrofit pattern as
 *  runtime-helpers.ts's LOAD_MODEL_HELPER_VERSION. injectPerfProbe() used to
 *  guard on marker PRESENCE only — fine while the script never changed
 *  behavior, but the 2026-08-05 hidden-tab fix (below) needs to actually
 *  REACH games that were already previewed once (and so already carry an old
 *  probe), not just new ones. Bump this whenever buildPerfProbeScript()'s
 *  BEHAVIOR changes. v3 (2026-08-06): snapshots carry `playing` — see below.
 *  v5 (2026-08-15): the rAF wrap no longer defeats the frame governor's 60fps
 *  cap (KNOWN_BUGS #12) — every stored game carrying a v4 probe is currently
 *  running uncapped on a 120Hz device, so this bump is the whole delivery
 *  mechanism for that fix. */
export const PERF_PROBE_VERSION = 5;

/** How recently the kid must have touched the game (pointer/key/touch inside
 *  the iframe) for a snapshot to count as "playing". Owner report 2026-08-06:
 *  the slowdown banner fired on unstarted games and idle multiplayer lobbies
 *  — near-zero fps while nothing is being played is DESIGN (frame governor,
 *  no game loop yet), not lag. Lag is only ever FELT during play. */
export const PLAYING_INPUT_WINDOW_MS = 10_000;

export function computeLoad(triangles: number, instances: number, animated: boolean): number {
  return triangles * instances * (animated ? ANIMATED_LOAD_MULTIPLIER : 1);
}

/** For a model placed via loadModelBatch() (runtime-helpers.ts): every
 *  placement shares one InstancedMesh per geometry/material part, so DRAW
 *  CALLS — not raw instance count — is what predicts render cost; using
 *  computeLoad()'s formula unmodified would keep a 200-instance forest in
 *  the red bucket even after batching removed 199 of its 200 draw calls. */
export function computeBatchedLoad(triangles: number, drawCalls: number): number {
  return triangles * drawCalls;
}

export function bucketFor(load: number): LoadBucket {
  if (load <= LOAD_GREEN_MAX) return "green";
  if (load <= LOAD_YELLOW_MAX) return "yellow";
  return "red";
}

/** Marker so injection is idempotent (same pattern as every other injected
 *  script here — game-console.ts, preview-verify.ts, the frame governor). */
export const PERF_PROBE_MARKER = "<!--ari-perf-probe-->";

/**
 * The probe script. Runs in the iframe's own global scope, no bundler/module
 * system — only `window`, `parent.postMessage`, `setInterval`,
 * `requestAnimationFrame`. Buffers posts until the parent's ready handshake,
 * exactly like game-console.ts / preview-verify.ts.
 *
 * NOTE: the bucket thresholds/multiplier are interpolated as literal numbers
 * (not re-derived) so the injected copy can never drift from
 * computeLoad()/bucketFor() above — the same technique preview-verify.ts uses
 * for SETTLE_MS/CLICK_WAIT_MS.
 */
export function buildPerfProbeScript(): string {
  return `
(function () {
  window.__arPerfProbeVersion = ${PERF_PROBE_VERSION};
  var buffer = [];
  var ready = false;
  function send(ev) {
    try { parent.postMessage({ source: "${PERF_PROBE_SOURCE}", event: ev }, "*"); } catch (e) { /* parent gone */ }
  }
  function post(ev) { if (ready) send(ev); else buffer.push(ev); }
  addEventListener("message", function (event) {
    var d = event && event.data;
    if (!d || d.source !== "${PARENT_READY_SOURCE}" || d.type !== "ready") return;
    ready = true;
    for (var i = 0; i < buffer.length; i++) send(buffer[i]);
    buffer = [];
  });

  // GL draw-call counter (v4, 2026-08-10). snapshot.drawCalls was designed to
  // read __arPerf.renderer.info — which NOTHING ever assigned, so it was null
  // in every snapshot ever posted. Meanwhile the owner's AutoRicksaw game ran
  // at 1,250 draws/frame from hand-built meshes the model accounting cannot
  // see, and the slowdown hint blamed two static trees nine edits in a row.
  // Count actual GL draw commands instead: engine-agnostic, needs nothing
  // from the game, reaches stored games via the version re-floor.
  var glDraws = 0;
  function wrapGL(proto) {
    if (!proto) return;
    try {
      var de = proto.drawElements;
      if (de) proto.drawElements = function () { glDraws++; return de.apply(this, arguments); };
      var da = proto.drawArrays;
      if (da) proto.drawArrays = function () { glDraws++; return da.apply(this, arguments); };
      var dei = proto.drawElementsInstanced;
      if (dei) proto.drawElementsInstanced = function () { glDraws++; return dei.apply(this, arguments); };
      var dai = proto.drawArraysInstanced;
      if (dai) proto.drawArraysInstanced = function () { glDraws++; return dai.apply(this, arguments); };
    } catch (e) { /* never break rendering for telemetry */ }
  }
  if (!window.__arGlDrawPatched) {
    window.__arGlDrawPatched = 1;
    wrapGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    wrapGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  }
  var lastGlDraws = 0;

  // FPS estimate: count rAF ticks in the last sample window.
  //
  // This does NOT "stack fine" on the frame governor, as it claimed until
  // 2026-08-15 (KNOWN_BUGS #12). The governor throttles per callback via a
  // WeakMap keyed on the function it is handed; a fresh closure per call —
  // which is what the naive wrap below produced — means it never saw the same
  // key twice, so its prev timestamp was always 0 and the 60fps cap never fired.
  // On a 120Hz ProMotion device every 3D game therefore did twice the work,
  // and any game moving per-frame ran twice as fast: exactly the heating the
  // governor was built to stop.
  //
  // Two rules keep the callback's IDENTITY stable through this wrap:
  //  1. memoise one wrapper per callback, so a game re-requesting the same
  //     loop function always presents the governor the same key;
  //  2. never re-wrap our own wrapper — the governor's skip path re-requests
  //     through window.requestAnimationFrame (i.e. back through here) with the
  //     wrapper it was given, and wrapping that again would both restart the
  //     identity problem and double-count the frame.
  var frames = 0;
  var origRaf = window.requestAnimationFrame;
  if (origRaf) {
    var wrappedByCb = typeof WeakMap === "function" ? new WeakMap() : null;
    window.requestAnimationFrame = function (cb) {
      if (typeof cb !== "function" || cb.__arPerfWrapped) return origRaf.call(window, cb);
      var wrapped = wrappedByCb && wrappedByCb.get(cb);
      if (!wrapped) {
        wrapped = function (t) {
          frames++;
          return cb(t);
        };
        wrapped.__arPerfWrapped = 1;
        if (wrappedByCb) wrappedByCb.set(cb, wrapped);
      }
      return origRaf.call(window, wrapped);
    };
  }

  // "Playing" signal (v3, owner report 2026-08-06): frames alone can't tell
  // "running slow" from "not running" — an unstarted game or idle lobby
  // renders little/nothing by design. Track the last real input so the
  // slowdown banner only trusts samples taken while the kid is actually
  // playing. Capture phase: game code often stopPropagation()s.
  var lastInput = 0;
  var inputEvents = ["pointerdown", "keydown", "touchstart"];
  for (var ie = 0; ie < inputEvents.length; ie++) {
    addEventListener(inputEvents[ie], function () { lastInput = Date.now(); }, true);
  }

  function snapshot() {
    // A hidden tab/panel genuinely renders zero frames — that's true, but it
    // is NOT the same claim as "the game is running slow," which is what
    // this snapshot exists to detect. Without this guard, every setInterval
    // tick during a background gap (leaving Ari and coming back) posts a
    // near-zero fps reading, which is enough on its own to satisfy the
    // slowdown banner's "5 consecutive low samples" rule — so the banner
    // flashes on return even though nothing was ever actually slow. Skip
    // sampling entirely while hidden, and keep resetting the frame counter
    // so no partial/corrupted count leaks into the first reading after the
    // tab becomes visible again.
    if (document.hidden) { frames = 0; return; }
    var perf = window.__arPerf || {};
    var reg = perf.models || {};
    var animatedRoots = perf.animatedRoots;
    var models = [];
    for (var name in reg) {
      if (!Object.prototype.hasOwnProperty.call(reg, name)) continue;
      var entry = reg[name];
      var roots = entry.instances || [];
      // Live = still parented into a scene graph. A load()ed-but-never-added
      // (or later removed) root reads parent as falsy — never a stale row.
      var live = [];
      for (var i = 0; i < roots.length; i++) {
        if (roots[i] && roots[i].parent) live.push(roots[i]);
      }
      if (live.length === 0) continue;
      var animated = false;
      if (animatedRoots) {
        for (var j = 0; j < live.length; j++) {
          if (animatedRoots.has(live[j])) { animated = true; break; }
        }
      }
      var triangles = entry.triangles || 0;
      var load = triangles * live.length * (animated ? ${ANIMATED_LOAD_MULTIPLIER} : 1);
      var bucket = load <= ${LOAD_GREEN_MAX} ? "green" : (load <= ${LOAD_YELLOW_MAX} ? "yellow" : "red");
      models.push({ name: name, triangles: triangles, instances: live.length, animated: animated, load: load, bucket: bucket });
    }
    var batches = perf.batches || {};
    for (var bname in batches) {
      if (!Object.prototype.hasOwnProperty.call(batches, bname)) continue;
      var bentry = batches[bname];
      var broots = bentry.roots || [];
      var blive = false;
      for (var bi = 0; bi < broots.length; bi++) { if (broots[bi] && broots[bi].parent) { blive = true; break; } }
      if (!blive) continue;
      var btriangles = bentry.triangles || 0;
      var bdrawCalls = bentry.drawCalls || 1;
      var bload = btriangles * bdrawCalls;
      var bbucket = bload <= ${LOAD_GREEN_MAX} ? "green" : (bload <= ${LOAD_YELLOW_MAX} ? "yellow" : "red");
      models.push({ name: bentry.name, triangles: btriangles, instances: bentry.count || 0, animated: false, load: bload, bucket: bbucket, batched: true, drawCalls: bdrawCalls });
    }
    models.sort(function (a, b) { return b.load - a.load; });
    var drawCalls = null, rendererTriangles = null;
    // Per-frame average over this window from the GL counter — the value
    // that actually distinguishes "a thousand tiny meshes" from "two trees".
    var windowDraws = glDraws - lastGlDraws;
    lastGlDraws = glDraws;
    if (windowDraws > 0 && frames > 0) {
      drawCalls = Math.round(windowDraws / frames);
    } else if (perf.renderer && perf.renderer.info && perf.renderer.info.render) {
      // Legacy fallback, kept for a game that registers its renderer.
      drawCalls = perf.renderer.info.render.calls;
      rendererTriangles = perf.renderer.info.render.triangles;
    }
    var playing = frames > 0 && lastInput > 0 && (Date.now() - lastInput) < ${PLAYING_INPUT_WINDOW_MS};
    post({ type: "snapshot", snapshot: { fps: frames, playing: playing, drawCalls: drawCalls, rendererTriangles: rendererTriangles, models: models } });
    frames = 0;
  }
  setInterval(snapshot, ${PERF_SAMPLE_MS});
})();
`.trim();
}

const PERF_PROBE_VERSION_RE = /window\.__arPerfProbeVersion\s*=\s*(\d+)/;
// Matches the marker comment + the WHOLE script tag that follows it, so a
// stale probe can be removed cleanly rather than left to run alongside (and
// after, in document order) the fresh one — same reasoning as
// ensure-runtime.ts's stripStaleLoadModelHelper.
const PERF_PROBE_BLOCK_RE = new RegExp(
  `${PERF_PROBE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<script>[\\s\\S]*?<\\/script>`,
);

/** Idempotent injection, mirroring preview-verify.ts's
 *  injectPreviewInstrumentation() shape. Called from ensureAssetRuntime
 *  alongside the frame governor — the ONLY path that reaches 3D games that
 *  already exist (2026-07-29 precedent: ArtifactFrame re-floors every
 *  preview render, so an old stored game gets the new engine bundle + probe
 *  automatically, no per-game migration). Version-aware since 2026-08-05: a
 *  game already carrying an OLDER probe (missing the hidden-tab fix) gets it
 *  replaced, not skipped — presence alone used to be treated as "done." */
export function injectPerfProbe(html: string): string {
  const m = html.match(PERF_PROBE_VERSION_RE);
  if (m && Number(m[1]) >= PERF_PROBE_VERSION) return html;
  const stripped = html.includes(PERF_PROBE_MARKER) ? html.replace(PERF_PROBE_BLOCK_RE, "") : html;
  return insertEarly(stripped, `${PERF_PROBE_MARKER}<script>${buildPerfProbeScript()}</script>`);
}
