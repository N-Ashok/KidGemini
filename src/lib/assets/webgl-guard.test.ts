// The WebGL context guard's SECOND job (2026-08-10, same day as its first):
// a lost context must FREEZE the game's loop, not kill it.
//
// Why: when the browser evicts a context, three.js's renderer keeps being
// called for one more frame and throws (`null.trim` in getUniforms — the GL
// introspection APIs return null while a context is lost). Games request
// their next frame AFTER rendering (three's own setAnimationLoop does too),
// so that throw KILLS the loop. preventDefault + webglcontextrestored then
// bring the CONTEXT back — but nothing is left running to draw with it. That
// is the owner's "blank, and clicking does not restart it".
//
// The cure is the governor's own pattern: while any tracked context is lost,
// rAF callbacks are re-requested instead of run — the chain can never die —
// and the game resumes by itself on webglcontextrestored.
//
// Exercised in node:vm like perf-probe.test.ts. The real-browser proof is
// scripts/harness-preview.mjs (§8) — this file pins the mechanism.
import { describe, it, expect, beforeEach } from "vitest";
import vm from "node:vm";
import { webglContextGuard } from "./runtime-helpers";

type Listener = (e: unknown) => void;

function boot() {
  const rafQueue: Array<(t: number) => void> = [];
  const warnings: string[] = [];
  const windowListeners = new Map<string, Listener[]>();

  const sandbox: Record<string, unknown> = {
    console: { warn: (m: string) => warnings.push(m) },
    HTMLCanvasElement: class {
      // Instance listeners land on the object via the guard's addEventListener
      listeners = new Map<string, Listener[]>();
      addEventListener(type: string, fn: Listener) {
        const l = this.listeners.get(type) ?? [];
        l.push(fn);
        this.listeners.set(type, l);
      }
      fire(type: string) {
        for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault: () => {} });
      }
      getContext(_type: string) {
        return null; // replaced below — prototype patching needs a base impl
      }
    },
    addEventListener: (type: string, fn: Listener) => {
      const l = windowListeners.get(type) ?? [];
      l.push(fn);
      windowListeners.set(type, l);
    },
    Object,
  };
  sandbox.window = sandbox;
  (sandbox.window as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };

  const ctxFactory = () => ({
    lost: false,
    getExtension(name: string) {
      if (name !== "WEBGL_lose_context") return null;
      const self = this as { lost: boolean };
      return { loseContext: () => void (self.lost = true) };
    },
  });
  (sandbox.HTMLCanvasElement as { prototype: { getContext: unknown } }).prototype.getContext =
    function (this: unknown, _type: string) {
      return ctxFactory();
    };

  const script = webglContextGuard().replace(/^<script>/, "").replace(/<\/script>$/, "");
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  const win = sandbox.window as {
    requestAnimationFrame: (cb: (t: number) => void) => unknown;
    __arGlCount: number;
  };
  // Flush the current queue ONCE (skipped callbacks re-queue behind it).
  const tick = (t: number) => {
    const q = rafQueue.splice(0);
    for (const cb of q) cb(t);
  };
  const makeCanvas = () => {
    const Canvas = sandbox.HTMLCanvasElement as new () => {
      getContext: (t: string) => unknown;
      fire: (t: string) => void;
    };
    const c = new Canvas();
    c.getContext("webgl");
    return c;
  };
  const post = (data: unknown) => {
    for (const fn of windowListeners.get("message") ?? []) fn({ data });
  };
  const pagehide = () => {
    for (const fn of windowListeners.get("pagehide") ?? []) fn({});
  };
  return { win, tick, makeCanvas, post, pagehide, warnings, rafQueue };
}

describe("webglContextGuard — the loop survives a context loss", () => {
  let g: ReturnType<typeof boot>;
  beforeEach(() => {
    g = boot();
  });

  it("normal times: rAF callbacks run", () => {
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    expect(ran).toBe(1);
  });

  it("while a context is lost, callbacks are HELD — re-requested, never run, chain alive", () => {
    const canvas = g.makeCanvas();
    canvas.fire("webglcontextlost");
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    g.tick(32);
    expect(ran).toBe(0); // three.js never renders against the dead context…
    expect(g.rafQueue.length).toBeGreaterThan(0); // …but the loop is NOT dead
  });

  it("on webglcontextrestored the held loop resumes by itself", () => {
    const canvas = g.makeCanvas();
    canvas.fire("webglcontextlost");
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    expect(ran).toBe(0);
    canvas.fire("webglcontextrestored");
    g.tick(32);
    expect(ran).toBe(1);
  });

  it("two canvases: the loop is held until the LAST lost context restores", () => {
    const a = g.makeCanvas();
    const b = g.makeCanvas();
    a.fire("webglcontextlost");
    b.fire("webglcontextlost");
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    a.fire("webglcontextrestored");
    g.tick(16);
    expect(ran).toBe(0);
    b.fire("webglcontextrestored");
    g.tick(32);
    expect(ran).toBe(1);
  });

  it("a spurious restore (no prior loss) never wedges the counter negative", () => {
    const canvas = g.makeCanvas();
    canvas.fire("webglcontextrestored"); // must clamp at 0, not go to -1
    canvas.fire("webglcontextlost");
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    expect(ran).toBe(0); // a real loss still holds the loop
  });

  it("release-gl still frees every tracked context (first job intact)", () => {
    g.makeCanvas();
    g.makeCanvas();
    expect(g.win.__arGlCount).toBe(2);
    g.post({ __ari: "release-gl" });
    expect(g.win.__arGlCount).toBe(0);
    expect(g.warnings.some((w) => w.includes("released (asked)"))).toBe(true);
  });

  it("pagehide still releases (backstop intact)", () => {
    g.makeCanvas();
    g.pagehide();
    expect(g.win.__arGlCount).toBe(0);
    expect(g.warnings.some((w) => w.includes("released (pagehide)"))).toBe(true);
  });
});
