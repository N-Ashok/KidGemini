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

/** Each failed attempt at a level makes the NEXT attempt at it wait longer,
 *  rather than banning it outright.
 *
 *  This started life as a permanent block after two failures, and a real
 *  browser caught why that was wrong: an occluded window throttled to 30fps
 *  and the governor — reading a browser throttle as fill cost — walked a game
 *  that runs at 60fps to the 0.75 floor and would have pinned it there. Low
 *  fps is not proof that pixels are the problem: an unfocused window, a
 *  main-thread stall during generation, or a GC pause all look identical from
 *  here. Backing off instead of banning means the worst case is a slow climb
 *  back, not a permanently soft game on a perfectly capable machine. */
export const UPSHIFT_BACKOFF_FACTOR = 3;
/** Never wait longer than this before retrying a level (5 minutes). */
export const MAX_UPSHIFT_BACKOFF_MS = 300_000;

/** A downshift must buy at least this much more frame rate to be kept.
 *
 *  The governor's whole premise is that PIXELS are the bottleneck — true on
 *  the Chromebook that prompted it, and false whenever something else is
 *  capping the frame rate: an occluded window, a display running at 30Hz, a
 *  main-thread stall during generation, battery saver. Those look identical
 *  from in here, and a real browser proved the point — a focused window that
 *  Chrome was throttling to 30fps dragged a 60fps game to the 0.75 floor,
 *  even with a hasFocus() guard in place, because focus was never the thing
 *  that was wrong.
 *
 *  So the claim is MEASURED rather than assumed: take the frame rate before
 *  the step, take it again after, and if the pixels were not the problem, put
 *  them back. A wrong guess then costs one sample of softness instead of the
 *  whole session. */
export const DOWNSHIFT_MUST_HELP_RATIO = 1.1;
/** After a downshift that did not help, stop trying to cut pixels for a
 *  while — whatever is capping the frame rate, it is not fill. */
export const FILL_RULED_OUT_COOLDOWN_MS = 60_000;

export const RESOLUTION_GOVERNOR_VERSION = 1;
export const RESOLUTION_GOVERNOR_MARKER = "<!--ari-resolution-governor-->";

export interface GovernorState {
  /** The ratio currently applied. */
  pixelRatio: number;
  /** The game's own choice — never exceeded. */
  ceiling: number;
  /** Whether the last sample changed the ratio (the caller applies it). */
  changed: boolean;
  lastChangeAt: number;
  slowSince: number;
  fastSince: number;
  /** How many times each level has failed to hold. */
  attempts: Record<string, number>;
  /** Earliest time each level may be retried (backoff, not a ban). */
  retryAfter: Record<string, number>;
  /** A downshift awaiting its verdict: did cutting pixels actually help? */
  pending: { from: number; fpsBefore: number } | null;
  /** While set, fill has been ruled out — stop cutting pixels until then. */
  fillRuledOutUntil: number;
}

export function initialGovernorState(ceiling: number): GovernorState {
  return {
    pixelRatio: ceiling,
    ceiling,
    changed: false,
    lastChangeAt: 0,
    slowSince: 0,
    fastSince: 0,
    attempts: {},
    retryAfter: {},
    pending: null,
    fillRuledOutUntil: 0,
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
  sample: { fps: number; now: number; trustworthy?: boolean },
): GovernorState {
  const { fps, now } = sample;

  // A hidden/paused preview renders ~0fps BY DESIGN (the frame governor stops
  // it). Treating that as evidence would walk the ladder to the floor while
  // the kid reads the chat, and they would come back to a needlessly soft
  // game. Same guard, same reason, as perf-probe.ts's document.hidden check.
  if (fps <= 0) return { ...state, changed: false, slowSince: 0, fastSince: 0 };

  // Only frame rates measured while the page is visible AND focused say
  // anything about the GPU. A real browser caught this: an occluded window
  // was throttled to 30fps and the governor read it as fill cost, walking a
  // 60fps game to the floor. Everything the caller cannot vouch for is
  // discarded rather than acted on.
  if (sample.trustworthy === false) {
    return { ...state, changed: false, slowSince: 0, fastSince: 0 };
  }

  const next: GovernorState = { ...state, changed: false };

  // Verdict on the previous step: did cutting pixels actually buy frames? If
  // not, the bottleneck was never fill — put the pixels back and stop cutting
  // for a while. This is what keeps a browser throttle (or a 30Hz display)
  // from walking a perfectly fast game down to the floor.
  if (state.pending) {
    next.pending = null;
    if (fps < state.pending.fpsBefore * DOWNSHIFT_MUST_HELP_RATIO) {
      next.pixelRatio = state.pending.from;
      next.changed = true;
      next.lastChangeAt = now;
      next.fillRuledOutUntil = now + FILL_RULED_OUT_COOLDOWN_MS;
      next.slowSince = 0;
      next.fastSince = 0;
      return next;
    }
  }

  if (fps < DOWNSHIFT_FPS) {
    next.fastSince = 0;
    next.slowSince = state.slowSince || now;
    if (now - next.slowSince >= DOWNSHIFT_SUSTAIN_MS && now >= state.fillRuledOutUntil) {
      const target = stepDown(state.pixelRatio);
      if (target !== null) {
        // Remember that the level we are leaving could not be held, and make
        // the next attempt at it wait longer — geometric backoff, capped.
        const key = String(state.pixelRatio);
        const failures = (state.attempts[key] ?? 0) + 1;
        next.attempts = { ...state.attempts, [key]: failures };
        const wait = Math.min(
          UPSHIFT_SUSTAIN_MS * Math.pow(UPSHIFT_BACKOFF_FACTOR, failures),
          MAX_UPSHIFT_BACKOFF_MS,
        );
        next.retryAfter = { ...state.retryAfter, [key]: now + wait };
        next.pixelRatio = target;
        next.pending = { from: state.pixelRatio, fpsBefore: fps };
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
      const readyAt = target === null ? 0 : (state.retryAfter[String(target)] ?? 0);
      if (target !== null && now >= readyAt) {
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
  var BACKOFF = ${UPSHIFT_BACKOFF_FACTOR}, MAX_BACKOFF = ${MAX_UPSHIFT_BACKOFF_MS};
  var MUST_HELP = ${DOWNSHIFT_MUST_HELP_RATIO}, FILL_RULED_OUT_MS = ${FILL_RULED_OUT_COOLDOWN_MS};

  var frames = 0;
  var raf = window.requestAnimationFrame;
  if (raf) {
    window.requestAnimationFrame = function (cb) {
      return raf.call(window, function (t) { frames++; return cb(t); });
    };
  }

  var state = null;      // initialised once a renderer shows up
  var attempts = {};
  var retryAfter = {};
  var pending = null;          // a downshift awaiting its verdict
  var fillRuledOutUntil = 0;   // while set, cutting pixels is known not to help
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
    // Discard any sample the browser itself may have throttled: hidden, or
    // simply not the focused window (an occluded tab is capped near 30fps,
    // which is indistinguishable from a slow GPU from in here). hasFocus is
    // absent in some embeddings — treat missing as focused rather than
    // freezing the governor entirely.
    var focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
    if (document.hidden || !focused || f <= 0) { slowSince = 0; fastSince = 0; return; }
    var r = renderer();
    if (!r || typeof r.setPixelRatio !== "function") return;
    if (state === null) {
      var start = 2;
      try { start = r.getPixelRatio(); } catch (e) { /* keep default */ }
      state = { ratio: start, ceiling: start };
    }
    var now = Date.now();

    // Verdict on the previous step: did cutting pixels actually buy frames?
    // If not, whatever is capping the frame rate is not fill — put the pixels
    // back and stop cutting for a while.
    if (pending) {
      var helped = f >= pending.fpsBefore * MUST_HELP;
      var wasPending = pending;
      pending = null;
      if (!helped) {
        state.ratio = wasPending.from;
        apply(r, wasPending.from);
        fillRuledOutUntil = now + FILL_RULED_OUT_MS;
        slowSince = 0; fastSince = 0;
        return;
      }
    }

    if (f < DOWN_FPS) {
      fastSince = 0;
      slowSince = slowSince || now;
      if (now - slowSince >= DOWN_MS && now >= fillRuledOutUntil) {
        var down = stepDown(state.ratio);
        if (down !== null) {
          var key = String(state.ratio);
          attempts[key] = (attempts[key] || 0) + 1;
          retryAfter[key] = now + Math.min(UP_MS * Math.pow(BACKOFF, attempts[key]), MAX_BACKOFF);
          pending = { from: state.ratio, fpsBefore: f };
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
        if (up !== null && now >= (retryAfter[String(up)] || 0)) {
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
