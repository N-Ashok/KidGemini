// Self-healing preview — verify pass (PRD-SELF-HEALING-PREVIEW §4–§6, platform docs).
// Two halves, both pure (no DOM, no React):
//  1. buildVerifyScript()/injectPreviewInstrumentation() — the probe script
//     injected into the game HTML. The iframe is an opaque origin (sandbox=
//     "allow-scripts", no allow-same-origin), so probes MUST run inside the
//     game document and report raw EVIDENCE to the parent via postMessage.
//  2. classifyVerify() — turns evidence + captured errors into a §7 failure
//     code. Classification lives HERE (parent side, testable), not in the
//     injected script, so the taxonomy can evolve without touching injection.

import type { GameConsoleMessage } from "@/types/game-console.types";
import type { VerifyClassification, VerifyEvidence } from "@/types/preview-verify.types";
import { injectConsoleCapture } from "./game-console";

export const PREVIEW_VERIFY_SOURCE = "kidgemini-preview-verify" as const;
export const PARENT_READY_SOURCE = "kidgemini-parent" as const;

// §9 timing table. Settle lets synchronous-on-load games tick a few frames;
// the pixel window catches frozen loops; the click wait gives a Start
// handler's first frame time to land.
export const SETTLE_MS = 1_500;
export const PIXEL_WINDOW_MS = 800;
export const CLICK_WAIT_MS = 1_000;

/** Marker so injection is idempotent (same pattern as the console capture). */
const MARKER = "<!--kidgemini-preview-verify-->";

/**
 * The probe script. Runs in the iframe's own global scope before the game's
 * code — no bundler, no modules. Wraps requestAnimationFrame IMMEDIATELY
 * (must win the race against the game script), then probes after `load` +
 * settle. Buffers all posts until the parent's ready handshake, like the
 * console capture (the parent listener mounts in an effect).
 */
export function buildVerifyScript(): string {
  return `
(function () {
  var buffer = [];
  var ready = false;
  function send(ev) {
    try {
      parent.postMessage({ source: "${PREVIEW_VERIFY_SOURCE}", event: ev }, "*");
    } catch (e) { /* parent gone — nothing to do */ }
  }
  function post(ev) { if (ready) send(ev); else buffer.push(ev); }
  addEventListener("message", function (event) {
    var d = event && event.data;
    if (!d || d.source !== "${PARENT_READY_SOURCE}" || d.type !== "ready") return;
    ready = true;
    for (var i = 0; i < buffer.length; i++) send(buffer[i]);
    buffer = [];
  });

  // §5.2 frame counter — the single highest-signal bit: 0 after settle means
  // the loop never started, and it fires with no exception thrown.
  var rafCount = 0;
  var origRaf = window.requestAnimationFrame;
  if (origRaf) {
    window.requestAnimationFrame = function (cb) {
      rafCount++;
      return origRaf.call(window, cb);
    };
  }

  function biggestCanvas() {
    var cs = document.getElementsByTagName("canvas");
    var best = null, area = -1;
    for (var i = 0; i < cs.length; i++) {
      var r = cs[i].getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = cs[i]; }
    }
    return best;
  }

  // Cheap content hash of a downsampled copy. §6.3: drawing a CDN image under
  // the opaque origin taints the canvas — getImageData throws SecurityError.
  // A taint is INCONCLUSIVE, never "static".
  function snapshot(canvas) {
    try {
      var w = Math.min(canvas.width || 0, 64), h = Math.min(canvas.height || 0, 64);
      if (!w || !h) return "zero";
      var off = document.createElement("canvas");
      off.width = w; off.height = h;
      var ctx = off.getContext("2d");
      ctx.drawImage(canvas, 0, 0, w, h);
      var d = ctx.getImageData(0, 0, w, h).data;
      // Hash EVERY byte — sparse sampling let a small moving sprite slip
      // between samples and misread a healthy game as frozen (the §8.1
      // false-repair failure mode; caught in real-browser smoke testing).
      var acc = 0;
      for (var i = 0; i < d.length; i++) acc = ((acc * 31) + d[i]) >>> 0;
      return "h" + acc;
    } catch (e) { return "tainted"; }
  }

  // P4 — find the start control: the SMALLEST visible element whose text says
  // start/play/go/begin. Smallest, not largest: a full-screen "Tap Start!"
  // overlay matches the words too, but the real button is the innermost hit.
  function findStartControl() {
    var re = /\\b(start|play|go|begin)\\b/i;
    var els = document.querySelectorAll("button, [role=button], a, input, div, span, p, h1, h2, h3");
    var best = null, area = Infinity;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var text = ((el.innerText || el.textContent || el.value || "") + "").trim();
      if (!text || text.length > 60 || !re.test(text)) continue;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.width * r.height < area) { area = r.width * r.height; best = el; }
    }
    return best;
  }

  function selectorOf(el) {
    if (!el || !el.tagName) return null;
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.className && typeof el.className === "string") {
      var cls = el.className.trim().split(/\\s+/).slice(0, 2).join(".");
      if (cls) s += "." + cls;
    }
    return s;
  }

  function run() {
    var evidence = {
      rafCountAtSettle: rafCount,
      rafCountFinal: rafCount,
      canvas: null,
      pixel: null,
      pixelAfterClick: null,
      start: null
    };
    post({ type: "check", check: "loop", ok: rafCount > 0 });

    var canvas = biggestCanvas();
    if (canvas) {
      evidence.canvas = { width: canvas.width || 0, height: canvas.height || 0 };
      post({ type: "check", check: "canvas", ok: (canvas.width || 0) > 0 && (canvas.height || 0) > 0 });
    }

    function finish() {
      evidence.rafCountFinal = rafCount;
      post({ type: "result", evidence: evidence });
    }

    // P4/P5/P6 — locate the Start control, occlusion-test the tap point,
    // then dispatch a direct click (bypasses occlusion BY DESIGN, §6.2) and
    // let the "after" callback measure what changed.
    function startProbe(after) {
      var btn = findStartControl();
      if (!btn) {
        evidence.start = { found: false };
        post({ type: "check", check: "start", ok: false });
        finish();
        return;
      }
      var r = btn.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var hit = document.elementFromPoint ? document.elementFromPoint(cx, cy) : null;
      var occluded = !!hit && hit !== btn && !btn.contains(hit);
      evidence.start = {
        found: true,
        x: Math.round(cx),
        y: Math.round(cy),
        occluded: occluded,
        occluder: occluded ? selectorOf(hit) : null,
        clickRafDelta: null
      };
      post({ type: "check", check: "start", ok: !occluded });
      var before = rafCount;
      try { btn.click(); } catch (e) { /* handler threw — the error trap has it */ }
      setTimeout(function () {
        evidence.start.clickRafDelta = rafCount - before;
        after();
      }, ${CLICK_WAIT_MS});
    }

    if (evidence.rafCountAtSettle > 0) {
      // Loop is running — P3 checks it actually repaints (only meaningful with
      // a non-zero canvas; DOM-only games pass through).
      if (canvas && (canvas.width || 0) > 0 && (canvas.height || 0) > 0) {
        var s1 = snapshot(canvas);
        setTimeout(function () {
          var s2 = snapshot(canvas);
          evidence.pixel = (s1 === "tainted" || s2 === "tainted") ? "tainted"
            : (s1 === s2 ? "static" : "changing");
          post({ type: "check", check: "drawing", ok: evidence.pixel !== "static" });
          if (evidence.pixel !== "static") { finish(); return; }
          // Static with a RUNNING loop is often a title screen idling on its
          // Start button — static by design, not broken (found live, first
          // real generation). Click Start and re-sample before condemning.
          startProbe(function () {
            var s3 = snapshot(canvas);
            setTimeout(function () {
              var s4 = snapshot(canvas);
              evidence.pixelAfterClick = (s3 === "tainted" || s4 === "tainted") ? "tainted"
                : (s3 === s4 && s4 === s2 ? "static" : "changing");
              finish();
            }, ${PIXEL_WINDOW_MS});
          });
          return;
        }, ${PIXEL_WINDOW_MS});
        return;
      }
      finish();
      return;
    }

    // No loop — the start probe decides between occlusion, a dead flag, and
    // a game with no way to begin.
    startProbe(finish);
  }

  if (document.readyState === "complete") setTimeout(run, ${SETTLE_MS});
  else addEventListener("load", function () { setTimeout(run, ${SETTLE_MS}); });
})();
`.trim();
}

/** Injects console capture + verify probes (in that order, both pre-game).
 *  Idempotent. This is what ArtifactFrame feeds into srcDoc. */
export function injectPreviewInstrumentation(html: string): string {
  const withConsole = injectConsoleCapture(html);
  if (withConsole.includes(MARKER)) return withConsole;
  const script = `${MARKER}<script>${buildVerifyScript()}</script>`;
  // The console capture is already at the earliest injectable point; ride
  // directly behind it so both install before any game code.
  const anchor = "<!--kidgemini-console-capture-->";
  const idx = withConsole.indexOf(anchor);
  if (idx !== -1) {
    const afterCapture = withConsole.indexOf("</script>", idx) + "</script>".length;
    return withConsole.slice(0, afterCapture) + script + withConsole.slice(afterCapture);
  }
  return script + withConsole;
}

/**
 * §7 classification — evidence + captured errors → failure code.
 * Order matters: hard errors first (they explain everything downstream),
 * then the no-loop family, then canvas problems.
 * `interrupted` = the tab was hidden mid-window (§8.1 guard): rAF stops in
 * background tabs, so "no loop"/"frozen" reads become INCONCLUSIVE.
 */
export function classifyVerify(input: {
  errors: GameConsoleMessage[];
  evidence: VerifyEvidence | null;
  interrupted: boolean;
}): VerifyClassification {
  const { errors, evidence, interrupted } = input;

  const resource = errors.find((e) => e.kind === "resource");
  if (resource) return { code: "resource_404", evidence: evidence ?? emptyEvidence(), errors };

  const runtime = errors.find((e) => e.kind === "error" || e.kind === "rejection");
  if (runtime) {
    // An unhandled REJECTION at load is the async-init signature itself —
    // Chrome's rejection stacks don't always contain the literal words
    // "async"/"await" (verified in real-browser smoke testing), so kind
    // is the primary signal and the stack text the fallback.
    const haystack = `${runtime.stack ?? ""} ${runtime.text}`;
    const code =
      runtime.kind === "rejection" || /\basync\b|\bawait\b/i.test(haystack)
        ? "async_loop"
        : "load_error";
    return { code, evidence: evidence ?? emptyEvidence(), errors };
  }

  // No result posted (verify script never finished) — never repair blind.
  if (!evidence) return { code: "inconclusive" };

  if (evidence.rafCountAtSettle === 0) {
    if (interrupted) return { code: "inconclusive" }; // V.11 — backgrounded tab
    const start = evidence.start;
    if (start?.found) {
      if (start.occluded) return { code: "start_occluded", evidence, errors };
      if ((start.clickRafDelta ?? 0) > 0) return { code: "clean" }; // V.9 — legit start button
      return { code: "start_no_loop", evidence, errors };
    }
    return { code: "no_loop", evidence, errors };
  }

  if (evidence.canvas && (evidence.canvas.width === 0 || evidence.canvas.height === 0)) {
    return { code: "canvas_zero_size", evidence, errors };
  }
  if (evidence.pixel === "static") {
    if (interrupted) return { code: "inconclusive" };
    // Title-screen guard: a running loop idling on a start screen is static
    // BY DESIGN. If clicking Start made pixels move, the game is healthy —
    // and if the button was occluded, THAT is the bug, not the stillness.
    if (evidence.start?.found) {
      if (evidence.pixelAfterClick === "changing" || evidence.pixelAfterClick === "tainted") {
        return { code: "clean" };
      }
      if (evidence.start.occluded) return { code: "start_occluded", evidence, errors };
    }
    return { code: "canvas_static", evidence, errors };
  }
  return { code: "clean" };
}

function emptyEvidence(): VerifyEvidence {
  return { rafCountAtSettle: 0, rafCountFinal: 0, canvas: null, pixel: null, start: null };
}
