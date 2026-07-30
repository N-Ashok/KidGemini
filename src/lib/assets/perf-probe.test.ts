// docs/2026-07-30_PRD_PreviewPerfPanel.md — the debug-only per-model load
// probe. Owner decisions: colour is by LOAD not "cost" (that word implies
// money); load = triangles × live instance count × an animated multiplier.
// Two halves, both pure (no DOM/React), mirroring preview-verify.ts's shape:
//  - computeLoad()/bucketFor() — the ranking logic, tested directly (no vm
//    needed, unlike the injected script itself).
//  - buildPerfProbeScript()/injectPerfProbe() — the injected probe, exercised
//    in node:vm the same way preview-verify.test.ts / game-console.test.ts do.
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import {
  ANIMATED_LOAD_MULTIPLIER,
  LOAD_GREEN_MAX,
  LOAD_YELLOW_MAX,
  PERF_PROBE_MARKER,
  bucketFor,
  computeLoad,
  buildPerfProbeScript,
  injectPerfProbe,
} from "./perf-probe";
import { PERF_PROBE_SOURCE, PARENT_READY_SOURCE } from "../preview-messages";

describe("computeLoad / bucketFor — the ranking logic", () => {
  it("a single non-animated low-poly model is green", () => {
    const load = computeLoad(1_000, 1, false);
    expect(bucketFor(load)).toBe("green");
  });

  it("a modest crowd of non-animated instances can still be green if under the threshold", () => {
    const load = computeLoad(500, 10, false); // 5,000
    expect(load).toBeLessThanOrEqual(LOAD_GREEN_MAX);
    expect(bucketFor(load)).toBe("green");
  });

  it("crosses into yellow once load exceeds the green ceiling", () => {
    const load = computeLoad(LOAD_GREEN_MAX + 1, 1, false);
    expect(bucketFor(load)).toBe("yellow");
  });

  it("crosses into red once load exceeds the yellow ceiling", () => {
    const load = computeLoad(LOAD_YELLOW_MAX + 1, 1, false);
    expect(bucketFor(load)).toBe("red");
  });

  it("animation multiplies load — an animated model can tip red where its static twin stays yellow", () => {
    const triangles = 40_000;
    const instances = 3;
    const staticLoad = computeLoad(triangles, instances, false); // 120,000 — yellow
    const animatedLoad = computeLoad(triangles, instances, true); // 240,000 — red
    expect(bucketFor(staticLoad)).toBe("yellow");
    expect(bucketFor(animatedLoad)).toBe("red");
    expect(animatedLoad).toBe(staticLoad * ANIMATED_LOAD_MULTIPLIER);
  });

  it("the cricket-game scenario: 12 animated crowd instances of a modest model rank above 3 detailed static principals", () => {
    // The bug that prompted this PRD: 24 separately-animated characters heating
    // up a laptop, with no way to see which group was responsible.
    const crowd = computeLoad(6_000, 12, true); // 144,000
    const principals = computeLoad(30_000, 3, false); // 90,000
    expect(crowd).toBeGreaterThan(principals);
    expect(bucketFor(crowd)).toBe("yellow");
    expect(bucketFor(principals)).toBe("yellow");
  });

  it("zero instances is zero load (never divides, never NaN)", () => {
    expect(computeLoad(50_000, 0, true)).toBe(0);
    expect(bucketFor(computeLoad(50_000, 0, true))).toBe("green");
  });
});

describe("buildPerfProbeScript — injection shape", () => {
  it("injectPerfProbe is idempotent — a second pass adds no duplicate", () => {
    const html = "<!doctype html><html><head><title>Fox Run</title></head><body></body></html>";
    const once = injectPerfProbe(html);
    const twice = injectPerfProbe(once);
    expect(twice).toBe(once);
    expect((once.match(new RegExp(PERF_PROBE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(
      1,
    );
  });

  it("inserts right after <head> so it runs before game code", () => {
    const html = "<!doctype html><html><head><title>Fox Run</title></head><body></body></html>";
    const out = injectPerfProbe(html);
    const headIdx = out.indexOf("<head>");
    const scriptIdx = out.indexOf("<script>");
    const titleIdx = out.indexOf("<title>");
    expect(scriptIdx).toBeGreaterThan(headIdx);
    expect(scriptIdx).toBeLessThan(titleIdx);
  });
});

/** Runtime behavior of the injected script — evaluated in a real sandboxed
 *  context (node:vm), same technique as game-console.test.ts. */
describe("buildPerfProbeScript — runtime behavior (sandboxed via node:vm)", () => {
  function bootProbe() {
    const posted: any[] = [];
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    // The wrapped rAF calls straight through to this ORIGINAL mock — it just
    // stashes the wrapped inner callback so the test can fire it. A "frame"
    // is register-then-fire, exactly like a real game's animate() loop calls
    // requestAnimationFrame(loop) and the browser later invokes it.
    let rafCb: ((t: number) => void) | null = null;
    let intervalCb: (() => void) | null = null;
    const sandbox: Record<string, unknown> = {
      __arPerf: undefined,
      parent: { postMessage: (msg: unknown) => posted.push(msg) },
      addEventListener: (name: string, fn: (e: unknown) => void) => {
        (handlers[name] ??= []).push(fn);
      },
      requestAnimationFrame: (cb: (t: number) => void) => {
        rafCb = cb;
        return 1;
      },
      setInterval: (fn: () => void) => {
        intervalCb = fn;
        return 1;
      },
      window: undefined,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(buildPerfProbeScript(), sandbox);
    const ready = () =>
      handlers["message"]?.forEach((fn) => fn({ data: { source: PARENT_READY_SOURCE, type: "ready" } }));
    // sandbox.requestAnimationFrame is now the WRAPPED version (script
    // replaced window.requestAnimationFrame === sandbox.requestAnimationFrame).
    const tick = () => {
      (sandbox.requestAnimationFrame as (cb: (t: number) => void) => number)(() => {});
      rafCb?.(Date.now());
    };
    const sample = () => intervalCb?.();
    return { sandbox, posted, ready, tick, sample };
  }

  it("buffers snapshots until the parent's ready handshake, then flushes", () => {
    const { sandbox, posted, sample } = bootProbe();
    (sandbox as any).__arPerf = { models: {} };
    sample();
    expect(posted).toHaveLength(0);
  });

  it("posts a snapshot with fps/drawCalls/models after the ready handshake", () => {
    const { sandbox, posted, ready, tick, sample } = bootProbe();
    (sandbox as any).__arPerf = { models: {}, renderer: { info: { render: { calls: 7, triangles: 12_345 } } } };
    ready();
    tick();
    tick();
    sample();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      source: PERF_PROBE_SOURCE,
      event: { type: "snapshot", snapshot: { fps: 2, drawCalls: 7, rendererTriangles: 12_345 } },
    });
  });

  it("reports null drawCalls/triangles when no renderer is registered yet", () => {
    const { sandbox, posted, ready, sample } = bootProbe();
    (sandbox as any).__arPerf = { models: {} };
    ready();
    sample();
    expect(posted[0].event.snapshot.drawCalls).toBeNull();
    expect(posted[0].event.snapshot.rendererTriangles).toBeNull();
  });

  it("a model with a live (parented) instance is reported; one with no parent is omitted", () => {
    const { sandbox, posted, ready, sample } = bootProbe();
    const liveRoot = { parent: {} };
    const deadRoot = { parent: null };
    (sandbox as any).__arPerf = {
      models: {
        crowd: { triangles: 5_000, instances: [liveRoot, deadRoot] },
      },
    };
    ready();
    sample();
    const snapshot = posted[0].event.snapshot;
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]).toMatchObject({ name: "crowd", triangles: 5_000, instances: 1, animated: false });
  });

  it("a model whose every instance lost its parent is omitted entirely (no stale rows)", () => {
    const { sandbox, posted, ready, sample } = bootProbe();
    (sandbox as any).__arPerf = { models: { ghost: { triangles: 9_000, instances: [{ parent: null }] } } };
    ready();
    sample();
    expect(posted[0].event.snapshot.models).toHaveLength(0);
  });

  it("marks a model animated when its root is in animatedRoots, and sorts highest-load first", () => {
    const { sandbox, posted, ready, sample } = bootProbe();
    const heroRoot = { parent: {} };
    const treeRoot = { parent: {} };
    (sandbox as any).__arPerf = {
      models: {
        hero: { triangles: 6_000, instances: [heroRoot] },
        tree: { triangles: 40_000, instances: [treeRoot] },
      },
      animatedRoots: { has: (o: unknown) => o === heroRoot },
    };
    ready();
    sample();
    const models = posted[0].event.snapshot.models;
    // hero: 6,000 * 1 * multiplier; tree: 40,000 * 1 (static) — tree ranks first.
    expect(models.map((m: any) => m.name)).toEqual(["tree", "hero"]);
    expect(models.find((m: any) => m.name === "hero")).toMatchObject({ animated: true });
    expect(models.find((m: any) => m.name === "tree")).toMatchObject({ animated: false });
  });

  it("resets the frame counter every sample so fps reflects the last window only", () => {
    const { sandbox, posted, ready, tick, sample } = bootProbe();
    (sandbox as any).__arPerf = { models: {} };
    ready();
    tick();
    tick();
    tick();
    sample();
    tick();
    sample();
    expect(posted[0].event.snapshot.fps).toBe(3);
    expect(posted[1].event.snapshot.fps).toBe(1);
  });
});
