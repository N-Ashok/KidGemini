// A memory-backed stand-in for localStorage/sessionStorage, for games that run
// in the sandboxed preview (2026-08-16).
//
// THE FAULT: the preview iframe is sandbox="allow-scripts" with NO
// allow-same-origin, which is an opaque origin. Reading `localStorage` there
// does not return null — it THROWS. A game that reads a saved high score while
// building its state object therefore dies at init: the title screen paints
// (it is plain markup), and the Start button does nothing, because no handler
// was ever registered. To a child that is a finished game that will not start.
//
// Found by the golden-prompt run (docs/2026-08-08_PRD_AssetFitnessAndReview.md
// §4) and reproduced in that exact iframe before being fixed — bare: dead
// button; shimmed: the game plays.
//
// WHY A RUNTIME SHIM RATHER THAN A PROMPT RULE: a prompt rule reaches new
// builds only, and "remember my best score" is among the most common asks. The
// runtime floor is the ONLY path that reaches games that already exist, so
// every stored game with this fault heals on its next preview.
//
// The scores do not persist — in an opaque origin nothing can. A game that
// plays and forgets is enormously better than one that will not start, and the
// child's own device storage stays untouched, which is the point of the
// sandbox in the first place.

/** Present in every shimmed document; the idempotency key and the test anchor. */
export const STORAGE_SHIM_MARKER = "__arStorageShim";

/** Any mention at all of web storage. Deliberately broad: over-including 400
 *  bytes costs nothing, missing one leaves a child with a dead button. */
const USES_STORAGE_RE = /\b(?:local|session)Storage\b/;

/** Classic script, no module, no await — it must have already run before any
 *  of the game's own code touches storage. */
const SHIM = `<script>/*${STORAGE_SHIM_MARKER}*/(function(){
  function install(which){
    try { window[which].getItem("__ar"); return; } catch (e) {}
    var mem = {};
    var store = {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[String(k)] = String(v); },
      removeItem: function (k) { delete mem[String(k)]; },
      clear: function () { mem = {}; },
      key: function (i) { var ks = Object.keys(mem); return i < ks.length ? ks[i] : null; }
    };
    Object.defineProperty(store, "length", { get: function () { return Object.keys(mem).length; } });
    try { Object.defineProperty(window, which, { value: store, configurable: true, writable: true }); } catch (e) {}
  }
  install("localStorage");
  install("sessionStorage");
})();</script>`;

/**
 * Prepend the storage shim to a game that touches web storage.
 *
 * Idempotent, and a no-op for a game that never mentions storage. Placement is
 * the whole point: it goes as early as the document allows, ahead of the game's
 * first script, so the stand-in exists before anything reads it.
 */
export function ensureStorageShim(html: string): string {
  if (!html || !USES_STORAGE_RE.test(html)) return html;
  if (html.includes(STORAGE_SHIM_MARKER)) return html;

  // Prefer just inside <head>; then just inside <body>; then the very front.
  // Never after the first script — a shim that runs late is no shim at all.
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}${SHIM}`);
  const body = html.match(/<body[^>]*>/i);
  if (body) return html.replace(body[0], `${body[0]}${SHIM}`);
  return SHIM + html;
}
