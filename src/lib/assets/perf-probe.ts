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

export function computeLoad(triangles: number, instances: number, animated: boolean): number {
  return triangles * instances * (animated ? ANIMATED_LOAD_MULTIPLIER : 1);
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

  // FPS estimate: count rAF ticks in the last sample window. Stacks fine on
  // top of the frame governor's own wrap (both call straight through).
  var frames = 0;
  var origRaf = window.requestAnimationFrame;
  if (origRaf) {
    window.requestAnimationFrame = function (cb) {
      return origRaf.call(window, function (t) {
        frames++;
        return cb(t);
      });
    };
  }

  function snapshot() {
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
    models.sort(function (a, b) { return b.load - a.load; });
    var drawCalls = null, rendererTriangles = null;
    if (perf.renderer && perf.renderer.info && perf.renderer.info.render) {
      drawCalls = perf.renderer.info.render.calls;
      rendererTriangles = perf.renderer.info.render.triangles;
    }
    post({ type: "snapshot", snapshot: { fps: frames, drawCalls: drawCalls, rendererTriangles: rendererTriangles, models: models } });
    frames = 0;
  }
  setInterval(snapshot, ${PERF_SAMPLE_MS});
})();
`.trim();
}

/** Idempotent injection, mirroring preview-verify.ts's
 *  injectPreviewInstrumentation() shape. Called from ensureAssetRuntime
 *  alongside the frame governor — the ONLY path that reaches 3D games that
 *  already exist (2026-07-29 precedent: ArtifactFrame re-floors every
 *  preview render, so an old stored game gets the new engine bundle + probe
 *  automatically, no per-game migration). */
export function injectPerfProbe(html: string): string {
  if (html.includes(PERF_PROBE_MARKER)) return html;
  return insertEarly(html, `${PERF_PROBE_MARKER}<script>${buildPerfProbeScript()}</script>`);
}
