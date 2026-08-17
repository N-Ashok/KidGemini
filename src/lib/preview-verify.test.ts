// PRD-SELF-HEALING-PREVIEW §13 test plan — V.x rows. The injected probe
// script runs in node:vm against a hand-built fake DOM (the iframe stand-in);
// classification rows are pure-function tests.
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import {
  PREVIEW_VERIFY_SOURCE,
  PARENT_READY_SOURCE,
  buildVerifyScript,
  injectPreviewInstrumentation,
  classifyVerify,
  demonstrablyRunning,
} from "./preview-verify";
import { repairFaultLine } from "./repair-prompt";
import type { VerifyEvidence } from "@/types/preview-verify.types";
import type { GameConsoleMessage } from "@/types/game-console.types";

// ── fake DOM helpers ────────────────────────────────────────────────────────

interface FakeEl {
  tagName: string;
  id?: string;
  className?: string;
  innerText?: string;
  textContent?: string;
  value?: string;
  width?: number;
  height?: number;
  rect: { left: number; top: number; width: number; height: number };
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  contains: (o: unknown) => boolean;
  click: () => void;
  getContext?: (kind: string) => unknown;
}

function el(overrides: Partial<FakeEl>): FakeEl {
  const rect = overrides.rect ?? { left: 0, top: 0, width: 100, height: 40 };
  return {
    tagName: "DIV",
    innerText: "",
    rect,
    getBoundingClientRect: () => rect,
    contains: () => false,
    click: () => {},
    ...overrides,
  };
}

/**
 * Boots the verify script in a sandbox standing in for the iframe window.
 * setTimeout runs callbacks IMMEDIATELY so settle/pixel/click windows all
 * elapse synchronously — tests assert on the final posted evidence.
 */
function bootVerify(opts: {
  canvases?: FakeEl[];
  clickables?: FakeEl[];
  elementFromPoint?: (x: number, y: number) => FakeEl | null;
  imageData?: () => { data: number[] };
  /** Runs after injection, standing in for the game's own script. */
  game?: (w: Record<string, any>) => void;
  /** Parent ready ack payload override (default verify:true). */
  ready?: Record<string, unknown>;
}) {
  const posted: any[] = [];
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  const rafCallbacks: Array<() => void> = [];
  const sandbox: Record<string, any> = {
    Infinity,
    Math,
    parent: { postMessage: (msg: unknown) => posted.push(msg) },
    addEventListener: (name: string, fn: (e: unknown) => void) => {
      (handlers[name] ??= []).push(fn);
    },
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    setInterval: () => 0,
    requestAnimationFrame: (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    },
    document: {
      readyState: "loading", // game "runs" before load — mirrors reality
      getElementsByTagName: (tag: string) => (tag === "canvas" ? (opts.canvases ?? []) : []),
      querySelectorAll: () => opts.clickables ?? [],
      elementFromPoint: opts.elementFromPoint ?? (() => null),
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => (opts.imageData ? opts.imageData() : { data: [0, 0, 0, 0] }),
        }),
      }),
    },
    window: undefined,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(buildVerifyScript(), sandbox);

  opts.game?.(sandbox); // game script executes after injection, before load
  handlers["message"]?.forEach((fn) =>
    fn({ data: { source: PARENT_READY_SOURCE, type: "ready", ...(opts.ready ?? {}) } }),
  );
  handlers["load"]?.forEach((fn) => fn({})); // load fires → settle elapses → probes run

  const result = posted.find((p) => p?.event?.type === "result");
  const checks = posted.filter((p) => p?.event?.type === "check").map((p) => p.event);
  return { posted, evidence: (result?.event?.evidence ?? null) as VerifyEvidence | null, checks };
}

const err = (m: Partial<GameConsoleMessage>): GameConsoleMessage =>
  ({ level: "error", text: "", ...m }) as GameConsoleMessage;

// ── injection shape ─────────────────────────────────────────────────────────

describe("injectPreviewInstrumentation", () => {
  it("injects console capture first, verify second, both before game code", () => {
    const html = "<!doctype html><html><head><script>game()</script></head></html>";
    const out = injectPreviewInstrumentation(html);
    const captureIdx = out.indexOf("ari-console-capture");
    const verifyIdx = out.indexOf("ari-preview-verify");
    const gameIdx = out.indexOf("game()");
    expect(captureIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(captureIdx);
    expect(gameIdx).toBeGreaterThan(verifyIdx);
  });

  it("is idempotent", () => {
    const html = "<!doctype html><html><head></head><body></body></html>";
    const once = injectPreviewInstrumentation(html);
    expect(injectPreviewInstrumentation(once)).toBe(once);
  });
});

// ── probe script behavior (V rows needing a live run) ──────────────────────

describe("verify script probes", () => {
  it("V.8 — healthy game: loop runs on load, pixels change, and the controls still get checked", () => {
    let frame = 0;
    const canvas = el({ tagName: "CANVAS", width: 400, height: 300, rect: { left: 0, top: 0, width: 400, height: 300 } });
    const { evidence, checks } = bootVerify({
      canvases: [canvas],
      imageData: () => ({ data: [frame++, 10, 20, 30] }), // differs every snapshot
      game: (w) => {
        w.requestAnimationFrame(() => {});
        w.requestAnimationFrame(() => {});
      },
    });
    expect(evidence).not.toBeNull();
    expect(evidence!.rafCountAtSettle).toBe(2);
    expect(evidence!.pixel).toBe("changing");
    // CONTRACT CHANGE 2026-08-17 (P7). This used to assert `start` was null —
    // "start probe skipped when loop runs". That skip is precisely why the
    // owner's "the take off and land buttons are not working" was invisible
    // through four shipped fixes: the loop ran and the canvas painted, so
    // verify stopped looking, while an invisible layer sat over the flight
    // controls. The probe now runs on the healthy path too, purely so the
    // GAMEPLAY controls can be occlusion-tested — which cannot be done before
    // Start is clicked, since verify always loads the game fresh and a start
    // screen covering the controls is correct behaviour.
    //
    // COST, deliberately recorded: healthy games now get one ghost click plus
    // CLICK_WAIT_MS, and the parent reloads any clicked document pristine, so
    // that is one extra iframe mount per verify. It happens behind the
    // "Testing your game…" cover, so the child sees a slightly longer cover
    // rather than a flash. Watch it against the WebGL context budget
    // (webglContextGuard) — extra mounts are the pressure that caused the
    // 2026-08-10 blank-preview saga.
    expect(evidence!.start).not.toBeNull();
    expect(evidence!.start!.found).toBe(false); // this fixture has no Start control
    expect(evidence!.controls ?? null).toBeNull(); // so nothing to test, and no false fault
    expect(classifyVerify({ errors: [], evidence, interrupted: false })).toEqual({ code: "clean" });
    expect(checks.find((c) => c.check === "loop")?.ok).toBe(true);
  });

  it("V.4 — game never calls rAF and has no start control → no_loop", () => {
    const { evidence } = bootVerify({});
    expect(evidence!.rafCountAtSettle).toBe(0);
    expect(evidence!.start).toEqual({ found: false });
    const c = classifyVerify({ errors: [], evidence, interrupted: false });
    expect(c.code).toBe("no_loop");
  });

  it("V.5 — canvas sized only in CSS (bitmap 0×0) → canvas_zero_size", () => {
    const canvas = el({ tagName: "CANVAS", width: 0, height: 0, rect: { left: 0, top: 0, width: 400, height: 300 } });
    const { evidence } = bootVerify({
      canvases: [canvas],
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(evidence!.canvas).toEqual({ width: 0, height: 0 });
    const c = classifyVerify({ errors: [], evidence, interrupted: false });
    expect(c.code).toBe("canvas_zero_size");
  });

  it("loop runs but the canvas never repaints → canvas_static", () => {
    const canvas = el({ tagName: "CANVAS", width: 400, height: 300, rect: { left: 0, top: 0, width: 400, height: 300 } });
    const { evidence } = bootVerify({
      canvases: [canvas],
      imageData: () => ({ data: [7, 7, 7, 7] }), // identical every snapshot
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(evidence!.pixel).toBe("static");
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).toBe("canvas_static");
  });

  it("title-screen guard — running loop, static pixels, but Start makes pixels move → clean", () => {
    // Found live on the first real generation: a loop idling on its title
    // screen is static BY DESIGN. Clicking Start must exonerate the game.
    let clicked = false;
    let frame = 0;
    const canvas = el({ tagName: "CANVAS", width: 400, height: 300, rect: { left: 0, top: 0, width: 400, height: 300 } });
    const btn = el({
      tagName: "BUTTON",
      innerText: "Start",
      rect: { left: 150, top: 200, width: 100, height: 40 },
      click: () => {
        clicked = true;
      },
    });
    const { evidence } = bootVerify({
      canvases: [canvas],
      clickables: [btn],
      elementFromPoint: () => btn,
      imageData: () => ({ data: clicked ? [frame++, 1, 2, 3] : [7, 7, 7, 7] }),
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(evidence!.pixel).toBe("static");
    expect(evidence!.pixelAfterClick).toBe("changing");
    expect(classifyVerify({ errors: [], evidence, interrupted: false })).toEqual({ code: "clean" });
  });

  it("title screen whose Start button is occluded → start_occluded, not canvas_static", () => {
    const canvas = el({ tagName: "CANVAS", width: 400, height: 300, rect: { left: 0, top: 0, width: 400, height: 300 } });
    const overlay = el({ tagName: "DIV", className: "modal", rect: { left: 0, top: 0, width: 400, height: 600 } });
    const btn = el({ tagName: "BUTTON", innerText: "Play", rect: { left: 150, top: 200, width: 100, height: 40 } });
    const { evidence } = bootVerify({
      canvases: [canvas],
      clickables: [btn, overlay],
      elementFromPoint: () => overlay,
      imageData: () => ({ data: [7, 7, 7, 7] }), // static before AND after (click blocked in spirit)
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).toBe("start_occluded");
  });

  it("§6.3 — tainted canvas is INCONCLUSIVE (clean), never canvas_static", () => {
    const canvas = el({ tagName: "CANVAS", width: 400, height: 300, rect: { left: 0, top: 0, width: 400, height: 300 } });
    const { evidence } = bootVerify({
      canvases: [canvas],
      imageData: () => {
        throw new Error("SecurityError: tainted");
      },
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(evidence!.pixel).toBe("tainted");
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).toBe("clean");
  });

  it("V.6 — Start button under a full-screen overlay → start_occluded + occluding selector", () => {
    const btn = el({
      tagName: "BUTTON",
      innerText: "Start",
      rect: { left: 150, top: 200, width: 100, height: 40 },
    });
    const overlay = el({
      tagName: "DIV",
      className: "overlay fullscreen",
      innerText: "", // overlay itself has no matching text
      rect: { left: 0, top: 0, width: 400, height: 600 },
    });
    const { evidence } = bootVerify({
      clickables: [btn, overlay],
      elementFromPoint: () => overlay, // the tap lands on the overlay
    });
    expect(evidence!.start).toMatchObject({ found: true, occluded: true, occluder: "div.overlay.fullscreen" });
    const c = classifyVerify({ errors: [], evidence, interrupted: false });
    expect(c.code).toBe("start_occluded");
  });

  it("V.7 — handler runs but the loop still doesn't start → start_no_loop", () => {
    const btn = el({
      tagName: "BUTTON",
      innerText: "▶ Play",
      rect: { left: 150, top: 200, width: 100, height: 40 },
      click: () => {
        /* sets gameStarted; loop checks isPlaying — nothing happens */
      },
    });
    const { evidence } = bootVerify({
      clickables: [btn],
      elementFromPoint: () => btn, // not occluded
    });
    expect(evidence!.start).toMatchObject({ found: true, occluded: false, clickRafDelta: 0 });
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).toBe("start_no_loop");
  });

  it("V.9 — legitimate Start button that starts the loop on click → clean after P6", () => {
    let w: Record<string, any> | null = null;
    const btn = el({
      tagName: "BUTTON",
      innerText: "Start",
      rect: { left: 150, top: 200, width: 100, height: 40 },
      click: () => w!.requestAnimationFrame(() => {}), // handler starts the loop
    });
    const { evidence } = bootVerify({
      clickables: [btn],
      elementFromPoint: () => btn,
      game: (win) => {
        w = win;
      },
    });
    expect(evidence!.start).toMatchObject({ found: true, occluded: false, clickRafDelta: 1 });
    expect(classifyVerify({ errors: [], evidence, interrupted: false })).toEqual({ code: "clean" });
  });

  // REGRESSION (BUG-FIX-LOG 2026-07-20): the parent decides the pristine
  // reload from the click — if the RESULT is lost (game clobbered postMessage,
  // hard timeout), the parent must still learn a click happened. The probe
  // announces the click as its own event, BEFORE dispatching it.
  it("announces a 'clicked' event the moment it ghost-clicks Start", () => {
    const order: string[] = [];
    const btn = el({
      tagName: "BUTTON",
      innerText: "Start",
      rect: { left: 150, top: 200, width: 100, height: 40 },
      click: () => order.push("dom-click"),
    });
    const { posted } = bootVerify({
      clickables: [btn],
      elementFromPoint: () => btn,
    });
    const clickedIdx = posted.findIndex((p) => p?.event?.type === "clicked");
    expect(clickedIdx).toBeGreaterThan(-1);
    expect(posted[clickedIdx].source).toBe(PREVIEW_VERIFY_SOURCE);
    // Announced before the result, so a lost result can't hide the click.
    expect(clickedIdx).toBeLessThan(posted.findIndex((p) => p?.event?.type === "result"));
  });

  it("a healthy game the probe never clicks posts NO 'clicked' event", () => {
    const { posted } = bootVerify({
      game: (w) => {
        w.requestAnimationFrame(() => {});
      },
      imageData: (() => {
        let n = 0;
        return () => ({ data: [n++, 0, 0, 0] }); // pixels changing
      })(),
      canvases: [el({ tagName: "CANVAS", width: 300, height: 200 })],
    });
    expect(posted.some((p) => p?.event?.type === "clicked")).toBe(false);
  });

  it("an interval-driven loop counts as running — no false no_loop on non-rAF games", () => {
    const { evidence } = bootVerify({
      game: (w) => {
        w.setInterval(() => {}, 16); // game loop via setInterval, zero rAF
      },
    });
    expect(evidence!.rafCountAtSettle).toBe(0);
    expect(evidence!.intervalCount).toBe(1);
    // P7 contract change 2026-08-17 (see V.8): the start probe now runs on the
    // healthy path too, so the gameplay controls can be occlusion-tested. This
    // fixture has no Start control and no buttons, so the probe finds nothing
    // and — the property that matters — invents no fault.
    expect(evidence!.start!.found).toBe(false);
    expect(evidence!.controls ?? null).toBeNull();
    expect(classifyVerify({ errors: [], evidence, interrupted: false })).toEqual({ code: "clean" });
  });

  it("ready ack with verify:false keeps the probes inert — no result, no ghost click", () => {
    let clicked = 0;
    const btn = el({
      tagName: "BUTTON",
      innerText: "Start",
      rect: { left: 150, top: 200, width: 100, height: 40 },
      click: () => {
        clicked++;
      },
    });
    const { evidence, posted } = bootVerify({
      clickables: [btn],
      elementFromPoint: () => btn,
      ready: { verify: false }, // post-verify pristine reload
    });
    expect(evidence).toBeNull(); // probes never ran
    expect(clicked).toBe(0); // the kid's Start button was never ghost-clicked
    expect(posted.filter((p) => p?.event?.type === "check")).toHaveLength(0);
  });

  it("picks the SMALLEST matching element — the button, not the 'Tap Start' overlay around it", () => {
    const overlay = el({
      tagName: "DIV",
      innerText: "Tap Start to play!",
      rect: { left: 0, top: 0, width: 400, height: 600 },
    });
    const btn = el({
      tagName: "BUTTON",
      innerText: "Start",
      rect: { left: 150, top: 200, width: 100, height: 40 },
    });
    const { evidence } = bootVerify({
      clickables: [overlay, btn],
      elementFromPoint: () => btn,
    });
    expect(evidence!.start).toMatchObject({ found: true, x: 200, y: 220 });
  });
});

// ── classification-only rows ────────────────────────────────────────────────

describe("classifyVerify — error-driven rows", () => {
  const evidence: VerifyEvidence = {
    rafCountAtSettle: 0,
    rafCountFinal: 0,
    canvas: null,
    pixel: null,
    start: null,
  };

  it("V.1 — load-time throw → load_error carrying the structured error", () => {
    const errors = [
      err({ kind: "error", text: "TypeError: x undefined (game.html:247:3)", filename: "game.html", line: 247, stack: "TypeError\n at gameLoop" }),
    ];
    const c = classifyVerify({ errors, evidence, interrupted: false });
    expect(c.code).toBe("load_error");
    expect("errors" in c && c.errors[0]!.line).toBe(247);
  });

  it("V.2 — async-wrapped init (stack shows async/await) → async_loop", () => {
    const errors = [
      err({ kind: "rejection", text: "Unhandled promise rejection: boom", stack: "Error: boom\n at async init (game.html:10:5)" }),
    ];
    expect(classifyVerify({ errors, evidence, interrupted: false }).code).toBe("async_loop");
  });

  it("V.2 regression — a rejection WITHOUT literal async/await in the stack is still async_loop", () => {
    // Real Chrome stacks for a sync-rejecting await don't say "async"
    // (found in browser smoke testing) — the rejection kind IS the signal.
    const errors = [
      err({ kind: "rejection", text: "Unhandled promise rejection: asset load failed", stack: "Error: asset load failed\n at init (game.html:5:3)" }),
    ];
    expect(classifyVerify({ errors, evidence, interrupted: false }).code).toBe("async_loop");
  });

  it("a plain synchronous throw (kind error, no async) stays load_error", () => {
    const errors = [err({ kind: "error", text: "TypeError: boom (g.html:3:1)", stack: "TypeError: boom\n at g.html:3:1" })];
    expect(classifyVerify({ errors, evidence, interrupted: false }).code).toBe("load_error");
  });

  it("V.3 — import-map / CDN URL 404 → resource_404 with the URL", () => {
    const errors = [err({ kind: "resource", text: "Failed to load: https://cdn.x/lib.js", url: "https://cdn.x/lib.js" })];
    const c = classifyVerify({ errors, evidence, interrupted: false });
    expect(c.code).toBe("resource_404");
  });

  it("resource errors outrank runtime errors (the 404 usually CAUSES the throw)", () => {
    const errors = [
      err({ kind: "error", text: "ReferenceError: Chess is not defined" }),
      err({ kind: "resource", url: "https://cdn.x/chess.js", text: "Failed to load: https://cdn.x/chess.js" }),
    ];
    expect(classifyVerify({ errors, evidence, interrupted: false }).code).toBe("resource_404");
  });

  it("V.11 — tab backgrounded mid-window: no_loop reads become inconclusive, no repair", () => {
    expect(classifyVerify({ errors: [], evidence, interrupted: true })).toEqual({ code: "inconclusive" });
  });

  it("missing result (verify script never finished) is inconclusive — never repair blind", () => {
    expect(classifyVerify({ errors: [], evidence: null, interrupted: false })).toEqual({ code: "inconclusive" });
  });
});

// ── P7: the GAMEPLAY controls, not just Start (2026-08-17) ─────────────────
//
// The owner's "the take off and land buttons are not working" survived FOUR
// shipped fixes. Every one aimed at the button logic; the logic was never the
// bug. The probe only ever hit-tested Start — Start was reachable, so verify
// reported the game clean while an invisible layer sat over the flight
// controls. Nothing looked, so nothing saw it.
//
// A false positive here is worse than a miss (it sends a WORKING game to the
// repair model), so the guards get as many tests as the detection.
describe("the probe itself finds occluded gameplay controls", () => {
  // Mirrors the owner's Mumbai Flight Sim: Start works, the loop runs, and a
  // HUD wrapper lies across the flight buttons.
  const startBtn = () => el({ tagName: "BUTTON", innerText: "Start", rect: { left: 150, top: 20, width: 100, height: 40 } });
  const upBtn = () => el({ tagName: "BUTTON", innerText: "UP", rect: { left: 20, top: 400, width: 60, height: 60 } });
  const landBtn = () => el({ tagName: "BUTTON", innerText: "LAND", rect: { left: 100, top: 400, width: 60, height: 60 } });
  const hud = () => el({ tagName: "DIV", className: "hud-wrap", rect: { left: 0, top: 380, width: 400, height: 220 } });

  it("P7.7 reports the buried controls, with a count and the occluder", () => {
    const start = startBtn(), up = upBtn(), land = landBtn(), wrap = hud();
    const { evidence } = bootVerify({
      clickables: [start, up, land, wrap],
      // Start is reachable; the two flight buttons are not. This is exactly
      // the state that reported "clean" for four shipped fixes in a row.
      elementFromPoint: (_x, y) => (y > 380 ? wrap : start),
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(evidence!.controls).toBeTruthy();
    expect(evidence!.controls!.occluded).toBe(2);
    expect(evidence!.controls!.occluder).toContain("hud-wrap");
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).toBe("controls_occluded");
  });

  it("P7.8 does not flag controls that are genuinely on top", () => {
    const start = startBtn(), up = upBtn();
    const { evidence } = bootVerify({
      clickables: [start, up],
      elementFromPoint: (_x, y) => (y > 380 ? up : start),
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(evidence!.controls!.occluded).toBe(0);
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).not.toBe("controls_occluded");
  });

  it("P7.9 ignores things that are not tap targets — the false-positive guard", () => {
    // A wordy menu item, and a control too small to be a real button. Flagging
    // either would send a WORKING game to the repair model, which is strictly
    // worse than missing one.
    const start = startBtn();
    const wordy = el({ tagName: "BUTTON", innerText: "Go to the settings screen", rect: { left: 20, top: 400, width: 200, height: 40 } });
    const tiny = el({ tagName: "BUTTON", innerText: "UP", rect: { left: 20, top: 500, width: 12, height: 12 } });
    const wrap = hud();
    const { evidence } = bootVerify({
      clickables: [start, wordy, tiny, wrap],
      elementFromPoint: (_x, y) => (y > 380 ? wrap : start),
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(evidence!.controls).toBeNull(); // nothing qualified as a control
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).not.toBe("controls_occluded");
  });

  it("P7.10 an off-screen control (elementFromPoint returns null) is not occlusion", () => {
    // elementFromPoint answers null for a point outside the viewport. Treating
    // that as "covered" would flag every game with a scrolled-out control.
    const start = startBtn(), up = upBtn();
    const { evidence } = bootVerify({
      clickables: [start, up],
      elementFromPoint: (_x, y) => (y > 380 ? null : start),
      game: (w) => w.requestAnimationFrame(() => {}),
    });
    expect(evidence!.controls!.occluded).toBe(0);
  });
});

describe("classifyVerify — controls_occluded", () => {
  const running: VerifyEvidence = {
    rafCountAtSettle: 5,
    rafCountFinal: 30,
    canvas: { width: 360, height: 240 },
    pixel: "changing",
    start: { found: true, occluded: false, clickRafDelta: 12 },
  };

  it("P7.1 a happily-animating game with buried controls is NOT clean", () => {
    // The exact production shape: every previous probe passes.
    const evidence: VerifyEvidence = {
      ...running,
      controls: { found: 4, occluded: 2, occluder: "div.hud-wrap", label: "LAND" },
    };
    const out = classifyVerify({ errors: [], evidence, interrupted: false });
    expect(out.code).toBe("controls_occluded");
  });

  it("P7.2 the repair instruction names the control, the occluder, and what NOT to touch", () => {
    // The 2026-08-17 finding: informing the model is the whole fix. Every
    // observed uninformed repair came back a no-op of a dozen characters.
    const line = repairFaultLine({
      failureCode: "controls_occluded",
      evidence: { ...running, controls: { found: 4, occluded: 2, occluder: "div.hud-wrap", label: "LAND" } },
      errors: [],
    });
    expect(line).toContain("LAND");
    expect(line).toContain("div.hud-wrap");
    expect(line).toMatch(/pointer-events/);
    expect(line).toMatch(/Do NOT change the buttons/i);
  });

  it("P7.3 controls found but NONE occluded stays clean", () => {
    const evidence: VerifyEvidence = { ...running, controls: { found: 4, occluded: 0, occluder: null } };
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).toBe("clean");
  });

  it("P7.4 a game with no on-screen controls at all stays clean", () => {
    // Keyboard-only games exist. `controls: null` must never read as a fault.
    expect(classifyVerify({ errors: [], evidence: { ...running, controls: null }, interrupted: false }).code)
      .toBe("clean");
    const { controls: _omitted, ...noField } = { ...running, controls: null };
    expect(classifyVerify({ errors: [], evidence: noField as VerifyEvidence, interrupted: false }).code)
      .toBe("clean");
  });

  it("P7.5 an interrupted (backgrounded) read is inconclusive, never a repair", () => {
    // Same posture as every other probe: never repair on an unreliable read.
    const evidence: VerifyEvidence = {
      ...running,
      controls: { found: 4, occluded: 2, occluder: "div.hud", label: "UP" },
    };
    expect(classifyVerify({ errors: [], evidence, interrupted: true }).code).toBe("inconclusive");
  });

  it("P7.6 a REAL failure still wins over an occluded control", () => {
    // Ordering guard: a game that never looped has a more basic problem, and
    // its controls are trivially "covered" by whatever screen is still up.
    const evidence: VerifyEvidence = {
      rafCountAtSettle: 0,
      rafCountFinal: 0,
      canvas: { width: 360, height: 240 },
      pixel: null,
      start: { found: true, occluded: true, occluder: "div.modal" },
      controls: { found: 3, occluded: 3, occluder: "div.modal", label: "UP" },
    };
    expect(classifyVerify({ errors: [], evidence, interrupted: false }).code).toBe("start_occluded");
  });
});

// REGRESSION (BUG-FIX-LOG 2026-07-20, false repair of a running game): the
// health read that gates repair spend — positive probe evidence only.
describe("demonstrablyRunning", () => {
  const base: VerifyEvidence = {
    rafCountAtSettle: 5,
    rafCountFinal: 12,
    canvas: { width: 360, height: 240 },
    pixel: "changing",
    start: null,
  };

  it("running loop + changing pixels = demonstrably running", () => {
    expect(demonstrablyRunning(base)).toBe(true);
  });

  it("running loop + no canvas at all (DOM game) = demonstrably running", () => {
    expect(demonstrablyRunning({ ...base, canvas: null, pixel: null })).toBe(true);
  });

  it("static-title screen that came alive after the probe's click counts", () => {
    expect(demonstrablyRunning({ ...base, pixel: "static", pixelAfterClick: "changing" })).toBe(true);
  });

  it("interval-driven loop counts as a loop", () => {
    expect(demonstrablyRunning({ ...base, rafCountAtSettle: 0, intervalCount: 1 })).toBe(true);
  });

  it("no evidence, no loop, zero canvas, or still-static pixels are NOT proof of health", () => {
    expect(demonstrablyRunning(null)).toBe(false);
    expect(demonstrablyRunning({ ...base, rafCountAtSettle: 0 })).toBe(false);
    expect(demonstrablyRunning({ ...base, canvas: { width: 0, height: 240 } })).toBe(false);
    expect(demonstrablyRunning({ ...base, pixel: "static" })).toBe(false);
    expect(demonstrablyRunning({ ...base, pixel: "tainted" })).toBe(false);
  });
});
