// Adaptive resolution governor (2026-08-15).
//
// Owner report: "in production the 3d games are slow" — the Ari chat preview,
// on a CHROMEBOOK. Production telemetry showed fps 14-28 at only 16-72 draw
// calls, which ruled out the 2026-08-10 draw-call story outright. Profiling
// the actual reported game (conversation 7aa4a11a…, pulled from the prod DB)
// found nothing to cut: 24 meshes, 63k triangles, 23 draw calls, 0.6ms of JS
// per frame, no shadows — 60fps on an M2.
//
// The one thing that moved it was PIXELS. Same game, fill-limited GPU:
//     880x1400 drawing buffer  ->  30fps
//     the same scene at half the pixels  ->  59fps
//     cheaper (non-PBR) shading instead  ->  32fps, i.e. nothing
// A weak integrated GPU cannot shade ~1.2M pixels a frame, and every game
// renders at full device resolution because the playbook tells the model to
// call setPixelRatio(Math.min(devicePixelRatio, 2)).
//
// So: spend exactly as many pixels as the device can afford, and let the
// device tell us how many rather than guessing per model. Owner decision
// (2026-08-15): adaptive, and SILENT — the kid never sees a message and
// nothing is reported to the server; the game just gets smooth.
//
// Injected through ensureAssetRuntime like the frame governor and the WebGL
// guard, which is the only path that reaches the ~200 games that already
// exist — their loops were written before any of this and an edit is a
// minimal patch that would never retrofit it.

/** Ladder of pixel ratios, richest first. The governor only ever walks DOWN
 *  from the ratio the game itself chose — it never adds pixels the author did
 *  not ask for, so a game that deliberately renders at 1 is left alone. */
export const RESOLUTION_LADDER = [2, 1.5, 1, 0.75] as const;

/** Below this, the kid can feel it. */
export const DOWNSHIFT_FPS = 50;
/** …but only after it has been true for this long: one bad second is a model
 *  load or a GC, not a verdict on the device. */
export const DOWNSHIFT_SUSTAIN_MS = 2_000;

/** Climbing back up demands a HIGHER bar than coming down did, held for
 *  LONGER — asymmetry is what stops the picture pumping between two ratios. */
export const UPSHIFT_FPS = 58;
export const UPSHIFT_SUSTAIN_MS = 5_000;

/** After this many failed attempts at a level, stop trying to reach it. A
 *  device that cannot hold 2.0 should settle at 1.5 for good rather than
 *  rediscovering the same limit every five seconds. */
export const MAX_UPSHIFT_ATTEMPTS = 2;

export const RESOLUTION_GOVERNOR_VERSION = 1;
export const RESOLUTION_GOVERNOR_MARKER = "<!--ari-resolution-governor-->";

export interface GovernorState {
  /** The ratio currently applied. */
  pixelRatio: number;
  /** The game's own choice — never exceeded. */
  ceiling: number;
  /** Ratios at or above this have failed too often to retry. */
  blockedAbove: number;
  /** Whether the last sample changed the ratio (the caller applies it). */
  changed: boolean;
  lastChangeAt: number;
  slowSince: number;
  fastSince: number;
  attempts: Record<string, number>;
}

export function initialGovernorState(ceiling: number): GovernorState {
  return {
    pixelRatio: ceiling,
    ceiling,
    blockedAbove: Infinity,
    changed: false,
    lastChangeAt: 0,
    slowSince: 0,
    fastSince: 0,
    attempts: {},
  };
}

function stepDown(from: number): number | null {
  for (const r of RESOLUTION_LADDER) if (r < from) return r;
  return null;
}

function stepUp(from: number, ceiling: number): number | null {
  const higher = RESOLUTION_LADDER.filter((r) => r > from && r <= ceiling);
  return higher.length ? Math.min(...higher) : null;
}

/**
 * One sample in, next state out. Pure — the injected copy calls the same
 * logic shape, and the constants below are interpolated into it verbatim so
 * the two can never drift.
 */
export function nextGovernorState(
  state: GovernorState,
  sample: { fps: number; now: number },
): GovernorState {
  const { fps, now } = sample;

  // A hidden/paused preview renders ~0fps BY DESIGN (the frame governor stops
  // it). Treating that as evidence would walk the ladder to the floor while
  // the kid reads the chat, and they would come back to a needlessly soft
  // game. Same guard, same reason, as perf-probe.ts's document.hidden check.
  if (fps <= 0) return { ...state, changed: false, slowSince: 0, fastSince: 0 };

  const next: GovernorState = { ...state, changed: false };

  if (fps < DOWNSHIFT_FPS) {
    next.fastSince = 0;
    next.slowSince = state.slowSince || now;
    if (now - next.slowSince >= DOWNSHIFT_SUSTAIN_MS) {
      const target = stepDown(state.pixelRatio);
      if (target !== null) {
        // Remember that the level we are leaving could not be held.
        const key = String(state.pixelRatio);
        next.attempts = { ...state.attempts, [key]: (state.attempts[key] ?? 0) + 1 };
        if ((next.attempts[key] ?? 0) >= MAX_UPSHIFT_ATTEMPTS) {
          next.blockedAbove = Math.min(state.blockedAbove, target);
        }
        next.pixelRatio = target;
        next.changed = true;
        next.lastChangeAt = now;
        next.slowSince = 0;
      }
    }
    return next;
  }

  if (fps >= UPSHIFT_FPS) {
    next.slowSince = 0;
    next.fastSince = state.fastSince || now;
    if (now - next.fastSince >= UPSHIFT_SUSTAIN_MS) {
      const target = stepUp(state.pixelRatio, state.ceiling);
      if (target !== null && target <= state.blockedAbove) {
        next.pixelRatio = target;
        next.changed = true;
        next.lastChangeAt = now;
        next.fastSince = 0;
      } else {
        // Nothing to climb to (or it is blocked) — stop re-arming, so a
        // settled game does no further work.
        next.fastSince = now;
      }
    }
    return next;
  }

  // In between: comfortable enough to stop counting down, not good enough to
  // earn a step up.
  next.slowSince = 0;
  next.fastSince = 0;
  return next;
}

/**
 * The injected script. Plain ES5 in the game's own global scope — no bundler,
 * no modules — matching every other injected helper here. Fails soft in every
 * direction: no renderer registered, no rAF, a throwing setSize — the game is
 * left exactly as it was.
 */
export function buildResolutionGovernorScript(): string {
  return `${RESOLUTION_GOVERNOR_MARKER}<script>
(function () {
  if (window.__arResGovernor) return;
  window.__arResGovernor = 1;
  window.__arResGovernorVersion = ${RESOLUTION_GOVERNOR_VERSION};

  var LADDER = ${JSON.stringify(RESOLUTION_LADDER)};
  var DOWN_FPS = ${DOWNSHIFT_FPS}, DOWN_MS = ${DOWNSHIFT_SUSTAIN_MS};
  var UP_FPS = ${UPSHIFT_FPS}, UP_MS = ${UPSHIFT_SUSTAIN_MS};
  var MAX_TRIES = ${MAX_UPSHIFT_ATTEMPTS};

  var frames = 0;
  var raf = window.requestAnimationFrame;
  if (raf) {
    window.requestAnimationFrame = function (cb) {
      return raf.call(window, function (t) { frames++; return cb(t); });
    };
  }

  var state = null;      // initialised once a renderer shows up
  var attempts = {};
  var blockedAbove = Infinity;
  var slowSince = 0, fastSince = 0;

  function renderer() {
    var p = window.__arPerf;
    return (p && p.renderer) || null;
  }

  function apply(r, ratio) {
    try {
      // setPixelRatio alone does not resize the drawing buffer — three only
      // re-reads it on setSize. Pass the CSS size back unchanged (and
      // updateStyle=false) so the canvas keeps its layout box and only the
      // backing resolution moves.
      // Read the CSS size off the canvas itself rather than r.getSize(), which
      // needs a three Vector2 this plain-ES5 scope has no import for.
      var el = r.domElement;
      var w = el ? el.clientWidth : 0;
      var h = el ? el.clientHeight : 0;
      r.setPixelRatio(ratio);
      // updateStyle=false: the canvas keeps its layout box; only the backing
      // buffer changes, so the game's own resize handling is untouched.
      if (w && h) r.setSize(w, h, false);
    } catch (e) { /* never break a running game for this */ }
  }

  function stepDown(from) {
    for (var i = 0; i < LADDER.length; i++) if (LADDER[i] < from) return LADDER[i];
    return null;
  }
  function stepUp(from, ceiling) {
    var best = null;
    for (var i = 0; i < LADDER.length; i++) {
      var r = LADDER[i];
      if (r > from && r <= ceiling && (best === null || r < best)) best = r;
    }
    return best;
  }

  setInterval(function () {
    var f = frames; frames = 0;
    if (document.hidden || f <= 0) { slowSince = 0; fastSince = 0; return; }
    var r = renderer();
    if (!r || typeof r.setPixelRatio !== "function") return;
    if (state === null) {
      var start = 2;
      try { start = r.getPixelRatio(); } catch (e) { /* keep default */ }
      state = { ratio: start, ceiling: start };
    }
    var now = Date.now();

    if (f < DOWN_FPS) {
      fastSince = 0;
      slowSince = slowSince || now;
      if (now - slowSince >= DOWN_MS) {
        var down = stepDown(state.ratio);
        if (down !== null) {
          var key = String(state.ratio);
          attempts[key] = (attempts[key] || 0) + 1;
          if (attempts[key] >= MAX_TRIES) blockedAbove = Math.min(blockedAbove, down);
          state.ratio = down;
          apply(r, down);
        }
        slowSince = 0;
      }
      return;
    }

    if (f >= UP_FPS) {
      slowSince = 0;
      fastSince = fastSince || now;
      if (now - fastSince >= UP_MS) {
        var up = stepUp(state.ratio, state.ceiling);
        if (up !== null && up <= blockedAbove) {
          state.ratio = up;
          apply(r, up);
          fastSince = 0;
        } else {
          fastSince = now;
        }
      }
      return;
    }

    slowSince = 0; fastSince = 0;
  }, 1000);
})();
</script>`;
}

const RESOLUTION_GOVERNOR_VERSION_RE = /window\.__arResGovernorVersion\s*=\s*(\d+)/;
const SCRIPT_BLOCK_RE = /<script[^>]*>[\s\S]*?<\/script>/g;

export function hasCurrentResolutionGovernor(html: string): boolean {
  const m = html.match(RESOLUTION_GOVERNOR_VERSION_RE);
  return !!m && Number(m[1]) >= RESOLUTION_GOVERNOR_VERSION;
}

export function stripStaleResolutionGovernor(html: string): string {
  return html
    .replace(SCRIPT_BLOCK_RE, (block) => (block.includes("__arResGovernor") ? "" : block))
    .split(RESOLUTION_GOVERNOR_MARKER)
    .join("");
}
