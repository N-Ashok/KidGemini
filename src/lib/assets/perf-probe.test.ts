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
  computeBatchedLoad,
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

describe("computeBatchedLoad — draw-call-based cost for loadModelBatch() placements", () => {
  it("a forest of 200 static instances collapsed into 1 draw call stays green, unlike the un-batched equivalent", () => {
    const unbatched = computeLoad(2_000, 200, false); // 400,000 — red
    const batched = computeBatchedLoad(2_000, 1); // 2,000 — green
    expect(bucketFor(unbatched)).toBe("red");
    expect(bucketFor(batched)).toBe("green");
  });

  it("scales with draw calls (distinct geometry/material parts), not with instance count", () => {
    const twoParts = computeBatchedLoad(5_000, 2);
    const fiveParts = computeBatchedLoad(5_000, 5);
    expect(fiveParts).toBeGreaterThan(twoParts);
    expect(twoParts).toBe(10_000);
  });

  it("zero draw calls is zero load (never NaN)", () => {
    expect(computeBatchedLoad(10_000, 0)).toBe(0);
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

  // 2026-08-05 — a game already previewed once carries an OLD probe baked
  // into its HTML; injectPerfProbe used to guard on marker PRESENCE only, so
  // the hidden-tab fix below would never have reached it. Version-aware now.
  it("a game with an OLDER (unversioned) probe gets it replaced with the current one", () => {
    const stalePage =
      `<!doctype html><html><head><title>Fox Run</title>${PERF_PROBE_MARKER}<script>(function(){` +
      `var frames=0;setInterval(function(){},1000);})();</script></head><body></body></html>`;
    const out = injectPerfProbe(stalePage);
    expect(out).toMatch(/window\.__arPerfProbeVersion\s*=\s*\d+/);
    expect(out).toContain("document.hidden"); // the actual fix content
    // Exactly one probe survives — the stale one was stripped, not left
    // alongside (would run first in document order and get overwritten
    // second, but is pure waste, and a future guard change could get this
    // wrong the way ensure-runtime.ts's stale-helper bug did).
    expect((out.match(new RegExp(PERF_PROBE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length).toBe(
      1,
    );
    expect(injectPerfProbe(out)).toBe(out); // settles immediately
  });

  it("a game already on the CURRENT probe version is left untouched (byte-identical)", () => {
    const html = "<!doctype html><html><head><title>Fox Run</title></head><body></body></html>";
    const once = injectPerfProbe(html);
    expect(injectPerfProbe(once)).toBe(once);
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
      document: { hidden: false },
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
    return { sandbox, posted, ready, tick, sample, handlers };
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

  it("a live batched entry (window.__arPerf.batches) is reported with drawCall-based load, not instance-count load", () => {
    const { sandbox, posted, ready, sample } = bootProbe();
    const container = { parent: {} };
    (sandbox as any).__arPerf = {
      models: {},
      batches: {
        forest: { name: "forest", triangles: 2_000, drawCalls: 1, count: 200, roots: [container] },
      },
    };
    ready();
    sample();
    const models = posted[0].event.snapshot.models;
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ name: "forest", instances: 200, load: 2_000, bucket: "green", batched: true, drawCalls: 1 });
  });

  it("a batched entry whose container lost its parent is omitted (no stale rows)", () => {
    const { sandbox, posted, ready, sample } = bootProbe();
    (sandbox as any).__arPerf = {
      models: {},
      batches: { ghostForest: { name: "ghostForest", triangles: 2_000, drawCalls: 1, count: 200, roots: [{ parent: null }] } },
    };
    ready();
    sample();
    expect(posted[0].event.snapshot.models).toHaveLength(0);
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

  // 2026-08-05 — "leave Ari and come back, the slowdown banner flashes for a
  // couple seconds": a hidden tab genuinely renders zero frames, but that is
  // NOT the same claim as "the game is slow" — posting it as a 0fps sample
  // was enough on its own to satisfy the banner's 5-consecutive-low-sample
  // rule the instant the tab became visible again.
  it("posts NOTHING while the tab is hidden — a background gap must never read as a slow-fps sample", () => {
    const { sandbox, posted, ready, tick, sample } = bootProbe();
    (sandbox as any).__arPerf = { models: {} };
    ready();
    tick();
    tick();
    (sandbox as any).document.hidden = true;
    sample(); // would-be near-zero-fps sample while backgrounded
    sample(); // a second tick, in case the interval fired more than once
    expect(posted).toHaveLength(0);
  });

  it("does not let frames accumulated before hiding leak into the first sample after becoming visible again", () => {
    const { sandbox, posted, ready, tick, sample } = bootProbe();
    (sandbox as any).__arPerf = { models: {} };
    ready();
    tick();
    tick();
    tick(); // 3 real frames before the tab is hidden
    (sandbox as any).document.hidden = true;
    sample(); // hidden — skipped, and the counter is cleared
    (sandbox as any).document.hidden = false;
    tick(); // exactly 1 real frame since becoming visible again
    sample();
    expect(posted).toHaveLength(1);
    expect(posted[0].event.snapshot.fps).toBe(1); // NOT 4 (3 stale + 1 fresh)
  });
// Owner report 2026-08-06 (probe v3): near-zero fps on an UNSTARTED game or
  // an idle multiplayer lobby is design (no game loop yet, frame governor),
  // not lag — so every snapshot now carries `playing`: frames were produced
  // AND the kid touched the game recently. The banner reducer
  // (slowdown-nudge.ts) only builds its streak from playing samples.
  it("playing=false when the kid has never touched the game, even with frames flowing", () => {
    const { sandbox, posted, ready, tick, sample } = bootProbe();
    (sandbox as any).__arPerf = { models: {} };
    ready();
    tick();
    tick();
    sample();
    expect(posted[0].event.snapshot.playing).toBe(false);
  });

  it("playing=true once recent input AND frames coincide", () => {
    const { sandbox, posted, ready, tick, sample, handlers } = bootProbe();
    (sandbox as any).__arPerf = { models: {} };
    ready();
    handlers["pointerdown"]?.forEach((fn) => fn({}));
    tick();
    sample();
    expect(posted[0].event.snapshot.playing).toBe(true);
  });

  it("playing=false when input is recent but NO frames rendered (game loop not running)", () => {
    const { sandbox, posted, ready, sample, handlers } = bootProbe();
    (sandbox as any).__arPerf = { models: {} };
    ready();
    handlers["keydown"]?.forEach((fn) => fn({}));
    sample();
    expect(posted[0].event.snapshot.fps).toBe(0);
    expect(posted[0].event.snapshot.playing).toBe(false);
  });
});

