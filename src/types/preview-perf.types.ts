// Preview Perf Panel types (docs/2026-07-30_PRD_PreviewPerfPanel.md). The
// injected perf-probe script (lib/assets/perf-probe.ts) computes the bucket
// itself (unlike preview-verify.ts, which posts raw evidence for the PARENT
// to classify) — there is no parent-side judgment call here, just relaying a
// snapshot, so the shape is simpler: one posted event, already resolved.

import type { PERF_PROBE_SOURCE } from "@/lib/preview-messages";

/** Owner decision 2026-07-30: colour is by LOAD (compute cost), never
 *  "cost" — that word implies money. */
export type LoadBucket = "green" | "yellow" | "red";

/** One named model's current standing, as read from window.__arPerf. */
export interface PerfModelEntry {
  name: string;
  /** Triangle count of one instance (recorded once per successful load). */
  triangles: number;
  /** How many currently-live (in-scene) instances of this model exist. */
  instances: number;
  /** True if any live instance has a constructed AnimationMixer. */
  animated: boolean;
  /** triangles × instances × (animated ? multiplier : 1). */
  load: number;
  bucket: LoadBucket;
}

/** One per-second sample posted by the injected probe. */
export interface PerfSnapshot {
  /** rAF ticks observed in the last sample window (~1s) — an FPS estimate. */
  fps: number;
  /** WebGLRenderer.info.render.calls at sample time, or null (no renderer
   *  registered yet — e.g. before the game constructs one). */
  drawCalls: number | null;
  /** WebGLRenderer.info.render.triangles at sample time, or null. */
  rendererTriangles: number | null;
  /** Sorted highest-load first; a model with zero live instances is omitted
   *  (never a stale row after a scene changes). */
  models: PerfModelEntry[];
}

/** postMessage envelope from the injected perf-probe script. */
export interface PerfProbePostedEvent {
  source: typeof PERF_PROBE_SOURCE;
  event: { type: "snapshot"; snapshot: PerfSnapshot };
}
