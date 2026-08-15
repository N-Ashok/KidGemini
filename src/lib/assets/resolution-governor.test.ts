// Tests for the adaptive resolution governor (2026-08-15).
//
// Owner report: "in production the 3d games are slow" — narrowed to the Ari
// chat preview on a CHROMEBOOK. Measured on the real stored game from the
// reporting chat (conversation 7aa4a11a…): 24 meshes, 63k triangles, 23 draw
// calls, 0.6ms of JS per frame, no shadows — 60fps on an M2, 30fps on a
// fill-limited GPU at the same 880x1400 drawing buffer, and 59fps the moment
// the pixel count is halved. Cheaper shading moved it 30 → 32. The game has
// no fat: it is pure fill cost, and the only lever that matters is how many
// pixels we ask the GPU to shade.
//
// So: watch the frame rate and spend exactly as many pixels as the device can
// afford. The ladder walks DOWN quickly (the kid is suffering now) and back UP
// slowly and conservatively (a step up that fails is a visible oscillation).
//
// The state machine is pure and lives here; buildResolutionGovernorScript()
// interpolates the same constants into the injected copy, the technique
// perf-probe.ts and the frame governor already use.

import { describe, it, expect } from "vitest";
import {
  RESOLUTION_LADDER,
  RESOLUTION_GOVERNOR_VERSION,
  RESOLUTION_GOVERNOR_MARKER,
  DOWNSHIFT_FPS,
  DOWNSHIFT_SUSTAIN_MS,
  UPSHIFT_FPS,
  UPSHIFT_SUSTAIN_MS,
  initialGovernorState,
  nextGovernorState,
  buildResolutionGovernorScript,
  hasCurrentResolutionGovernor,
  stripStaleResolutionGovernor,
} from "./resolution-governor";

/** Feed a run of identical samples, one per `stepMs`, returning the end state. */
function feed(
  state: ReturnType<typeof initialGovernorState>,
  fps: number,
  count: number,
  stepMs = 1000,
  startAt = 0,
) {
  let s = state;
  let t = startAt;
  for (let i = 0; i < count; i++) {
    t += stepMs;
    s = nextGovernorState(s, { fps, now: t });
  }
  return s;
}

describe("resolution ladder", () => {
  it("descends and never proposes more pixels than the game asked for", () => {
    // The game's own setPixelRatio(min(dpr,2)) is the ceiling: the governor
    // only ever takes pixels away, never adds beyond the author's intent.
    expect(RESOLUTION_LADDER[0]).toBe(2);
    expect([...RESOLUTION_LADDER].sort((a, b) => b - a)).toEqual([...RESOLUTION_LADDER]);
    expect(Math.min(...RESOLUTION_LADDER)).toBeGreaterThan(0);
  });
});

describe("nextGovernorState — downshift", () => {
  it("holds steady while the game is smooth", () => {
    const s = feed(initialGovernorState(2), 60, 10);
    expect(s.pixelRatio).toBe(2);
    expect(s.changed).toBe(false);
  });

  it("does NOT downshift on a single slow sample", () => {
    // One bad second is a model load, a GC, a tab regaining focus — not a
    // verdict on the device. Reacting to it would make every game flicker
    // resolution during its first seconds.
    const s = feed(initialGovernorState(2), 30, 1);
    expect(s.pixelRatio).toBe(2);
  });

  it("steps down one notch after sustained slowness", () => {
    const s = feed(initialGovernorState(2), 30, DOWNSHIFT_SUSTAIN_MS / 1000 + 1);
    expect(s.pixelRatio).toBe(1.5);
    expect(s.changed).toBe(true);
  });

  it("keeps stepping down on a genuinely fill-bound device, to the floor and no further", () => {
    // Fill-bound means each halving of the pixel count buys real frames — the
    // measured premise the governor now requires. This device is slow enough
    // that even the floor does not reach 50fps, so it walks the whole ladder.
    const fpsFor = (p: number) => 20 * (2 / p) ** 2 * 0.35;
    let s = initialGovernorState(2);
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 1000;
      s = nextGovernorState(s, { fps: fpsFor(s.pixelRatio), now: t });
    }
    const floor = RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1]!;
    expect(s.pixelRatio).toBe(floor);
  });

  it("a Chromebook-shaped run settles instead of oscillating", () => {
    // Fill-bound: fps roughly doubles each time the pixel count halves.
    let s = initialGovernorState(2);
    let t = 0;
    const fpsFor = (p: number) => Math.min(60, Math.round(30 * ((2 / p) ** 2) * 0.55));
    const seen: number[] = [];
    for (let i = 0; i < 120; i++) {
      t += 1000;
      s = nextGovernorState(s, { fps: fpsFor(s.pixelRatio), now: t });
      seen.push(s.pixelRatio);
    }
    // It must come to rest — the last 30 samples all at one ratio.
    const tail = new Set(seen.slice(-30));
    expect(tail.size).toBe(1);
    // And it must actually have helped.
    expect(s.pixelRatio).toBeLessThan(2);
  });
});

describe("nextGovernorState — upshift", () => {
  it("requires a HIGHER bar to go up than to come down (no flapping)", () => {
    expect(UPSHIFT_FPS).toBeGreaterThan(DOWNSHIFT_FPS);
    expect(UPSHIFT_SUSTAIN_MS).toBeGreaterThan(DOWNSHIFT_SUSTAIN_MS);
  });

  it("backs off — not bans — a level that keeps failing", () => {
    // Hysteresis: a device that cannot hold 2.0 must stop RETRYING it every
    // few seconds, or the kid watches the game soften and sharpen forever.
    // But it must never be banned outright: see the trustworthy-sample test
    // below for why low fps is not proof that pixels are the problem.
    let s = initialGovernorState(2);
    let t = 0;
    const slow = () => { for (let i = 0; i < DOWNSHIFT_SUSTAIN_MS / 1000 + 1; i++) { t += 1000; s = nextGovernorState(s, { fps: 28, now: t }); } };
    const fast = () => { for (let i = 0; i < UPSHIFT_SUSTAIN_MS / 1000 + 1; i++) { t += 1000; s = nextGovernorState(s, { fps: 60, now: t }); } };

    slow();                                   // 2.0 fails
    expect(s.pixelRatio).toBe(1.5);
    const firstWait = s.retryAfter["2"]! - s.lastChangeAt;

    t = s.retryAfter["2"]! + 1000;            // wait it out, climb back
    fast();
    expect(s.pixelRatio).toBe(2);

    slow();                                   // 2.0 fails a second time
    expect(s.pixelRatio).toBe(1.5);
    const secondWait = s.retryAfter["2"]! - s.lastChangeAt;

    // Retried, not banned — but each failure buys a longer wait.
    expect(secondWait).toBeGreaterThan(firstWait);
    expect(s.attempts["2"]).toBe(2);
  });

  it("DOES eventually climb back once the backoff has elapsed", () => {
    // The permanent ban this replaced would have pinned a 60fps machine at
    // the floor forever after two unlucky stalls.
    let s = initialGovernorState(2);
    let t = 0;
    for (let i = 0; i < DOWNSHIFT_SUSTAIN_MS / 1000 + 1; i++) { t += 1000; s = nextGovernorState(s, { fps: 28, now: t }); }
    expect(s.pixelRatio).toBe(1.5);
    t = s.retryAfter["2"]! + 1000; // wait the backoff out
    for (let i = 0; i < UPSHIFT_SUSTAIN_MS / 1000 + 1; i++) { t += 1000; s = nextGovernorState(s, { fps: 60, now: t }); }
    expect(s.pixelRatio).toBe(2);
  });

  it("never exceeds the ceiling it started from", () => {
    // A game that asked for pixelRatio 1 must never be pushed to 2 just
    // because the device is fast — that would be the governor ADDING cost.
    let s = initialGovernorState(1);
    s = feed(s, 60, 60);
    expect(s.pixelRatio).toBe(1);
  });
});

describe("hidden tab", () => {
  it("ignores samples taken while nothing is rendering", () => {
    // A backgrounded preview renders ~0fps by design (the frame governor
    // pauses it). Without this guard the governor would walk itself to the
    // floor while the kid is reading the chat, and they would come back to a
    // needlessly blurry game. Same lesson as perf-probe.ts's document.hidden
    // guard (2026-08-05).
    let s = initialGovernorState(2);
    s = feed(s, 0, 30);
    expect(s.pixelRatio).toBe(2);
  });
});

describe("a downshift must prove it helped", () => {
  it("reverts the step when cutting pixels bought nothing", () => {
    // The case a real browser produced: a focused, visible window that Chrome
    // was throttling to ~30fps. Fewer pixels cannot fix that, so the governor
    // must undo its own step rather than keep walking to the floor.
    let s = initialGovernorState(2);
    let t = 0;
    for (let i = 0; i < DOWNSHIFT_SUSTAIN_MS / 1000 + 1; i++) {
      t += 1000;
      s = nextGovernorState(s, { fps: 30, now: t });
    }
    expect(s.pixelRatio).toBe(1.5); // stepped down on the hypothesis…
    t += 1000;
    s = nextGovernorState(s, { fps: 30, now: t }); // …and it changed nothing
    expect(s.pixelRatio).toBe(2); // so the pixels go back
    expect(s.fillRuledOutUntil).toBeGreaterThan(t);
  });

  it("does not keep cutting pixels once fill has been ruled out", () => {
    let s = initialGovernorState(2);
    let t = 0;
    for (let i = 0; i < 60; i++) {
      t += 1000;
      s = nextGovernorState(s, { fps: 30, now: t }); // capped by something else
    }
    // One probe down and back, then it leaves the picture alone.
    expect(s.pixelRatio).toBe(2);
  });

  it("keeps the step when it genuinely helped", () => {
    // The Chromebook case: halving the pixels roughly doubles the frame rate.
    let s = initialGovernorState(2);
    let t = 0;
    for (let i = 0; i < DOWNSHIFT_SUSTAIN_MS / 1000 + 1; i++) {
      t += 1000;
      s = nextGovernorState(s, { fps: 30, now: t });
    }
    expect(s.pixelRatio).toBe(1.5);
    t += 1000;
    s = nextGovernorState(s, { fps: 52, now: t }); // fill really was the problem
    expect(s.pixelRatio).toBe(1.5);
    expect(s.fillRuledOutUntil).toBe(0);
  });
});

describe("untrustworthy samples", () => {
  it("ignores frame rates the browser itself may have throttled", () => {
    // Found in a REAL browser, not by reasoning: an occluded window was
    // throttled to ~30fps and the governor, reading that as fill cost, walked
    // a game that runs at 60fps all the way to the 0.75 floor. An unfocused
    // window, a main-thread stall mid-generation and a GC pause are all
    // indistinguishable from a slow GPU from inside the game — so a sample
    // the caller cannot vouch for is discarded, never acted on.
    let s = initialGovernorState(2);
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 1000;
      s = nextGovernorState(s, { fps: 30, now: t, trustworthy: false });
    }
    expect(s.pixelRatio).toBe(2);
  });

  it("still acts on trustworthy slow samples", () => {
    const s = feed(initialGovernorState(2), 30, DOWNSHIFT_SUSTAIN_MS / 1000 + 1);
    expect(s.pixelRatio).toBe(1.5);
  });
});

describe("injected script", () => {
  it("discards samples taken while the window is not focused", () => {
    // The injected copy must carry the same guard as the state machine above.
    const script = buildResolutionGovernorScript();
    expect(script).toMatch(/hasFocus/);
    expect(script).toMatch(/document\.hidden/);
  });

  it("carries its version stamp and marker so re-injection is version-aware", () => {
    const script = buildResolutionGovernorScript();
    expect(script).toContain(`window.__arResGovernorVersion = ${RESOLUTION_GOVERNOR_VERSION}`);
    expect(script).toContain("__arResGovernor");
  });

  it("interpolates the SAME constants the state machine uses", () => {
    // The injected copy can never be allowed to drift from the tested one.
    const script = buildResolutionGovernorScript();
    expect(script).toContain(String(DOWNSHIFT_FPS));
    expect(script).toContain(String(UPSHIFT_FPS));
    expect(script).toContain(JSON.stringify(RESOLUTION_LADDER));
  });

  it("is inert when no renderer was ever registered", () => {
    // Hand-built games that never expose a renderer must be untouched, not
    // broken — the floor's fail-soft rule.
    const script = buildResolutionGovernorScript();
    expect(script).toMatch(/__arPerf/);
    expect(script).toMatch(/renderer/);
  });
});

describe("version gating (the frozen-guard trap)", () => {
  const current = `${RESOLUTION_GOVERNOR_MARKER}<script>window.__arResGovernorVersion = ${RESOLUTION_GOVERNOR_VERSION};</script>`;
  const stale = `${RESOLUTION_GOVERNOR_MARKER}<script>window.__arResGovernorVersion = ${RESOLUTION_GOVERNOR_VERSION - 1};</script>`;

  it("treats a current stamp as done", () => {
    expect(hasCurrentResolutionGovernor(`<html>${current}</html>`)).toBe(true);
  });

  it("treats an OLDER stamp as not done — presence alone is never enough", () => {
    // This is the bug that froze the WebGL guard on ~200 stored games
    // (2026-08-11): gating on the marker's presence meant every later fix
    // silently never reached a game that already carried an old copy.
    expect(hasCurrentResolutionGovernor(`<html>${stale}</html>`)).toBe(false);
  });

  it("treats an unstamped game as not done", () => {
    expect(hasCurrentResolutionGovernor("<html><body>no governor</body></html>")).toBe(false);
  });

  it("strips a stale copy cleanly so two governors never run at once", () => {
    const out = stripStaleResolutionGovernor(`<html>${stale}<script>keep()</script></html>`);
    expect(out).not.toContain("__arResGovernorVersion");
    expect(out).toContain("keep()");
  });
});
