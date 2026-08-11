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
  const timers: Array<() => void> = [];
  const parentPosts: unknown[] = [];

  const sandbox: Record<string, unknown> = {
    console: { warn: (m: string) => warnings.push(m) },
    setTimeout: (fn: () => void, _ms: number) => {
      timers.push(fn);
      return timers.length;
    },
    parent: { postMessage: (d: unknown) => parentPosts.push(d) },
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
    Date,
    // diag() (2026-08-11 investigation) reads these — never throw here, or
    // every test in this file would trip the guard's own try/catch instead
    // of exercising the real log line.
    document: { visibilityState: "visible", hidden: false },
    navigator: { onLine: true },
  };
  sandbox.window = sandbox;
  (sandbox.window as Record<string, unknown>).requestAnimationFrame = (cb: (t: number) => void) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };

  // The fake browser half: losing/restoring through WEBGL_lose_context fires
  // the canvas's own events, the way a real browser does — so release() paths
  // interact with the guard's lostCount/loop-hold exactly as in production.
  (sandbox.HTMLCanvasElement as { prototype: { getContext: unknown } }).prototype.getContext =
    function (this: { fire: (t: string) => void }, _type: string) {
      const canvas = this;
      return {
        lost: false,
        isContextLost() {
          return (this as { lost: boolean }).lost;
        },
        getExtension(name: string) {
          if (name !== "WEBGL_lose_context") return null;
          const self = this as { lost: boolean };
          return {
            loseContext: () => {
              self.lost = true;
              canvas.fire("webglcontextlost");
            },
            restoreContext: () => {
              // A driver that refuses lets the watchdog's escalation be tested.
              if ((canvas as { refuseRestore?: boolean }).refuseRestore) return;
              self.lost = false;
              canvas.fire("webglcontextrestored");
            },
          };
        },
      };
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
      ctx?: { lost: boolean };
      refuseRestore?: boolean;
    };
    const c = new Canvas();
    c.ctx = c.getContext("webgl") as { lost: boolean };
    return c;
  };
  // Run every timer queued SO FAR (a nested setTimeout queued by a running
  // timer waits for the next flush — which is exactly the watchdog's
  // two-stage shape: flush #1 = the restore attempt, flush #2 = escalation).
  const flushTimers = () => {
    const q = timers.splice(0);
    for (const fn of q) fn();
  };
  const post = (data: unknown) => {
    for (const fn of windowListeners.get("message") ?? []) fn({ data });
  };
  const pagehide = (persisted = false) => {
    for (const fn of windowListeners.get("pagehide") ?? []) fn({ persisted });
  };
  const pageshow = (persisted = true) => {
    for (const fn of windowListeners.get("pageshow") ?? []) fn({ persisted });
  };
  return { win, tick, makeCanvas, post, pagehide, pageshow, warnings, rafQueue, flushTimers, parentPosts };
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

  it("a terminal pagehide (persisted=false, the teardown case) still releases", () => {
    g.makeCanvas();
    g.pagehide(false);
    expect(g.win.__arGlCount).toBe(0);
    expect(g.warnings.some((w) => w.includes("released (pagehide)"))).toBe(true);
  });

  // ── 2026-08-11 investigation: a non-persisted pagehide fired on the
  // STILL-PLAYING game mid-edit, with nothing in React deliberately changing
  // the iframe — shadow-verify's explicit 'release-gl' (sent right before
  // unmount) is gone, leaving this listener carrying more than it used to.
  // These diagnostics are what will tell us, from the next real occurrence,
  // whether it's a genuine backgrounding/connectivity event or something
  // else — never behavior-changing, so the log content itself is the point.
  it("a non-persisted pagehide logs visibility/online/timestamp diagnostics", () => {
    g.makeCanvas();
    g.pagehide(false);
    const line = g.warnings.find((w) => w.includes("NOT persisted"));
    expect(line).toBeDefined();
    expect(line).toContain("visibility=");
    expect(line).toContain("online=");
    expect(line).toContain("at=");
  });

  it("a persisted (backgrounded) pagehide ALSO logs diagnostics, even though it doesn't release", () => {
    g.makeCanvas();
    g.pagehide(true);
    const line = g.warnings.find((w) => w.includes("persisted, backgrounded"));
    expect(line).toBeDefined();
    expect(line).toContain("visibility=");
  });

  // ── 2026-08-10, second owner report: pane switch → freeze, tap back → blue ──
  // Safari/iOS fires pagehide when the page is merely BACKGROUNDED (app/tab
  // switch, pane transitions) and then brings it back — persisted=true.
  // Releasing there kills the LIVE game's context, and the loop-hold then
  // freezes it: exactly "froze, then turned blue when I clicked back".

  it("an iOS-style pagehide (persisted=true) does NOT release the live game", () => {
    const canvas = g.makeCanvas();
    void canvas;
    g.pagehide(true);
    expect(g.win.__arGlCount).toBe(1); // still tracked, still alive
    expect(g.warnings.some((w) => w.includes("released"))).toBe(false);
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    expect(ran).toBe(1); // and the loop was never held
  });

  it("pageshow after a release RESTORES the contexts and unfreezes the loop", () => {
    // Belt-and-braces for any browser that fires a non-persisted pagehide and
    // brings the page back anyway: the release must be reversible.
    g.makeCanvas();
    g.pagehide(false); // released → contextlost fired → loop held
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    expect(ran).toBe(0);
    g.pageshow();
    expect(g.win.__arGlCount).toBe(1); // tracked again
    g.tick(32);
    expect(ran).toBe(1); // restored → lostCount back to 0 → loop resumes
  });

  it("the hold engages SYNCHRONOUSLY — before the async webglcontextlost event lands", () => {
    // The browser dispatches webglcontextlost as a task, so counting events
    // leaves a window where three.js renders one frame against the dead
    // context and throws — the loop dies before the hold ever engages (the
    // harness's intermittent null.trim, back on 2026-08-10 §9's run). The
    // guard must poll isContextLost() on tracked contexts, not wait for the
    // event.
    const canvas = g.makeCanvas();
    canvas.ctx!.lost = true; // lost, event NOT yet delivered
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    expect(ran).toBe(0);
    canvas.ctx!.lost = false; // restored, event still not delivered
    g.tick(32);
    expect(ran).toBe(1);
  });

  // ── 2026-08-10 №4: "it didnot regain" — no browser restore ever arrived ──
  // Waiting politely for webglcontextrestored is not a plan: browsers do not
  // always volunteer it. The watchdog is the automatic version of what fixed
  // it for the owner by hand (switching code↔preview = a remount): first ASK
  // the driver (restoreContext), and if the context still won't come back,
  // tell the parent to remount this frame (gl-dead).

  it("watchdog stage 1: a loss with no restore event → the guard asks the driver itself", () => {
    const canvas = g.makeCanvas();
    canvas.ctx!.lost = true;
    canvas.fire("webglcontextlost");
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    expect(ran).toBe(0); // held
    g.flushTimers(); // the 2s restore attempt — fake driver honors it
    g.tick(32);
    expect(ran).toBe(1); // restored → resumed, no escalation
    g.flushTimers();
    expect(g.parentPosts).toEqual([]);
  });

  it("watchdog stage 2: the driver refuses → the guard asks the parent to remount (gl-dead)", () => {
    const canvas = g.makeCanvas();
    canvas.refuseRestore = true;
    canvas.ctx!.lost = true;
    canvas.fire("webglcontextlost");
    g.flushTimers(); // restore attempt — refused, still lost
    g.flushTimers(); // escalation
    expect(g.parentPosts).toEqual([{ __ari: "gl-dead" }]);
  });

  it("watchdog stands down when the browser restores on its own", () => {
    const canvas = g.makeCanvas();
    canvas.ctx!.lost = true;
    canvas.fire("webglcontextlost");
    canvas.ctx!.lost = false;
    canvas.fire("webglcontextrestored"); // browser did its job
    g.flushTimers();
    g.flushTimers();
    expect(g.parentPosts).toEqual([]);
  });

  it("pageshow with nothing released is a no-op (every normal load fires it)", () => {
    g.makeCanvas();
    g.pageshow();
    expect(g.win.__arGlCount).toBe(1);
    let ran = 0;
    g.win.requestAnimationFrame(() => ran++);
    g.tick(16);
    expect(ran).toBe(1);
  });
});
