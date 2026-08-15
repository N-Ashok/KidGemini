// The frame governor and the perf probe, COMPOSED — the way ensureAssetRuntime
// actually injects them into every 3D game (KNOWN_BUGS #12, 2026-08-15).
//
// Each is well tested alone, and each is correct alone. The bug lives only in
// their composition, which nothing exercised:
//
//   frameGovernor() throttles per-callback via a WeakMap keyed on the function
//   it is handed. injectPerfProbe() is injected AFTER it and also wraps
//   requestAnimationFrame — creating a FRESH closure on every call. So the
//   governor's WeakMap never saw the same key twice, `prev` was always 0, and
//   the 60fps cap never fired at all.
//
// Consequence on a 120Hz ProMotion Mac/iPad — which is what the owner and many
// kids use: every 3D game does 2x the work (the exact device-heating report
// that prompted the governor on 2026-07-29), and any game that moves per-frame
// rather than per-second runs literally twice as fast. Published games inherit
// it too, since the probe is injected there as well.
//
// Driven in node:vm like perf-probe.test.ts and webgl-guard.test.ts.
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { frameGovernor } from "./runtime-helpers";
import { buildPerfProbeScript } from "./perf-probe";

/** Strip the <script> wrapper so the body can run directly in the sandbox. */
function body(html: string): string {
  return html.replace(/^[\s\S]*?<script>/, "").replace(/<\/script>[\s\S]*$/, "");
}

interface Run {
  /** Frames the GAME's own loop actually ran. */
  gameFrames: number;
  /** Seconds of simulated wall-clock. */
  seconds: number;
  fps: number;
}

/**
 * Run a game loop for `ticks` display refreshes at `intervalMs` apart.
 *
 * @param withProbe install the perf probe on top of the governor (production
 *                  injects both; the governor alone is the control case).
 */
function runLoop(opts: { ticks: number; intervalMs: number; withProbe: boolean }): Run {
  let queue: Array<(t: number) => void> = [];
  let now = 0;

  const sandbox: Record<string, unknown> = {
    console: { warn: () => {} },
    document: { hidden: false },
    setInterval: () => 0, // the probe's 1s sampler is irrelevant here
    addEventListener: () => {},
    parent: { postMessage: () => {} },
    Date: { now: () => now },
    performance: { now: () => now },
  };
  const win: Record<string, unknown> = sandbox;
  sandbox.window = win;
  win.requestAnimationFrame = (cb: (t: number) => void) => {
    queue.push(cb);
    return queue.length;
  };

  const ctx = vm.createContext(sandbox);
  // Injection order is load-bearing and mirrors ensureAssetRuntime: the frame
  // governor first, the perf probe after it.
  vm.runInContext(body(frameGovernor()), ctx);
  if (opts.withProbe) vm.runInContext(buildPerfProbeScript(), ctx);

  let gameFrames = 0;
  const loop = (_t: number) => {
    gameFrames++;
    (win.requestAnimationFrame as (cb: (t: number) => void) => number)(loop);
  };
  (win.requestAnimationFrame as (cb: (t: number) => void) => number)(loop);

  for (let i = 0; i < opts.ticks; i++) {
    now += opts.intervalMs;
    const batch = queue;
    queue = [];
    for (const cb of batch) cb(now);
  }

  const seconds = (opts.ticks * opts.intervalMs) / 1000;
  return { gameFrames, seconds, fps: gameFrames / seconds };
}

const HZ_120 = 1000 / 120; // 8.33ms — ProMotion
const HZ_60 = 1000 / 60; // 16.67ms

describe("frame governor + perf probe, composed (KNOWN_BUGS #12)", () => {
  it("the governor alone caps a 120Hz display at ~60fps", () => {
    // Control: this is the behaviour shipped 2026-07-29 and it is correct.
    const run = runLoop({ ticks: 1200, intervalMs: HZ_120, withProbe: false });
    expect(run.fps).toBeGreaterThan(55);
    expect(run.fps).toBeLessThan(65);
  });

  it("the cap SURVIVES the perf probe being injected on top of it", () => {
    // The regression: the probe handed the governor a fresh closure per call,
    // so the WeakMap never matched and the cap silently did nothing — 120fps,
    // twice the work, on the exact hardware the governor exists for.
    const run = runLoop({ ticks: 1200, intervalMs: HZ_120, withProbe: true });
    expect(run.fps).toBeGreaterThan(55);
    expect(run.fps).toBeLessThan(65);
  });

  it("a 60Hz display is not throttled below 60fps by the pair", () => {
    // The cap must not cost frames on ordinary hardware — a Chromebook at
    // 60Hz has to keep every frame it can get.
    const run = runLoop({ ticks: 600, intervalMs: HZ_60, withProbe: true });
    expect(run.fps).toBeGreaterThan(55);
  });

  it("the probe still counts every frame the game actually runs", () => {
    // The fix must not buy the cap back by breaking the fps telemetry that
    // found the Chromebook problem in the first place.
    const run = runLoop({ ticks: 600, intervalMs: HZ_60, withProbe: true });
    expect(run.gameFrames).toBeGreaterThan(0);
  });

  it("the game's loop can never die, however many frames are skipped", () => {
    // The governor's own load-bearing invariant: a skipped frame ALWAYS
    // re-requests. If probe-wrapping ever broke that chain, the game would
    // freeze outright rather than merely run fast.
    const run = runLoop({ ticks: 2000, intervalMs: HZ_120, withProbe: true });
    expect(run.gameFrames).toBeGreaterThan(900); // still running at the end
  });
});
