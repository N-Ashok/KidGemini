// Remove OUR injected runtime from a stored game, for the copy the model reads.
//
// WHY (2026-08-16, owner asked where an edit turn's ~21,000 input tokens go):
// measured on two real stored games, the split is
//   injected runtime (ours)  ~8,400 tok   64% of the file
//   the child's game          ~3,400 tok   26%
//   html/css markup           ~1,300 tok   10%
// So two thirds of every edit turn is the loadModel/placeModel helper, the
// asset tables, the perf probe, the WebGL guard and the frame/resolution
// governors — code WE wrote and inject ourselves, replayed to the model on
// every single turn so it can read our WebGL guard while moving a house.
//
// The model never edits any of it, and `ensureAssetRuntime` puts all of it
// back (idempotently) on delivery. So the copy the model reads can drop it.
//
// THE SAFETY PROPERTY THAT MATTERS: the child's own code must come through
// BYTE-IDENTICAL. An edit is a SEARCH/REPLACE patch whose SEARCH text is
// matched against the STORED html — if stripping altered a single line of the
// game, every patch quoting that line would miss (`search_not_found`) and the
// child would lose their edit. Hence: this only ever removes WHOLE
// <script>/<style> blocks that carry an unmistakable injection signature, and
// never rewrites anything inside the game's own code.
//
// Signatures are ASSIGNMENTS (`window.loadModel =`), never mere mentions: a
// game that CALLS `loadModel("car")` or `placeModel(...)` must be kept, and
// today's games call both constantly.

/** Every <script>/<style> block, non-greedy so each match stays within one tag. */
const BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Marker comments the injectors leave behind, dropped alongside their block. */
const MARKER_RE =
  /<!--\s*ari-(?:perf-probe|console-capture|preview-verify|resolution-governor|credits-chip)\s*-->/gi;

/**
 * Signatures that identify a block as INJECTED. Each is anchored to something
 * only the injector writes:
 *  - table assignments (`window.AR_ASSETS=`), not reads;
 *  - helper definitions (`window.loadModel =`), not calls;
 *  - guard/governor/probe version stamps and their one-shot flags.
 */
const INJECTED_SIGNATURES: readonly RegExp[] = [
  /window\.AR_(?:ASSETS|SIZES|AXES|EDGES|FACING|REAL)\s*=/,
  /window\.(?:loadModel|loadModelBatch|placeModel|modelHeading|playSound|playMusic)\s*=\s*(?:async\s*)?function/,
  /window\.__arLoadModelVersion\s*=/,
  /window\.__arLoadModelBatchVersion\s*=/,
  /window\.__arGlGuard\b/,
  /window\.__arGlGuardVersion\s*=/,
  /window\.__arFrameGovernor\b/,
  /window\.__arResGovernor\b/,
  /window\.__arPerfProbeVersion\s*=/,
  /window\.__arGlDrawPatched\b/,
  // The console capture and verify probes post under these exact source names.
  /["']ari-game-console["']/,
  /["']ari-preview-verify["']/,
  /["']ari-parent["']\s*,?\s*type/,
  // The canvas floor is a <style> with its own id comment.
  /\/\*ari-3d-canvas-floor\*\//,
  // The sandboxed-preview storage stand-in (storage-shim.ts) carries its own
  // marker comment. Ours, so the model never spends tokens reading it — and
  // ensureAssetRuntime puts it back on the way out.
  /\/\*__arStorageShim\*\//,
];

/** The import map is ours too, and `ensureAssetRuntime` always re-emits it. */
const IMPORTMAP_RE = /<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;

/** True when a block is one of ours rather than part of the child's game. */
export function isInjectedBlock(block: string): boolean {
  return INJECTED_SIGNATURES.some((re) => re.test(block));
}

/**
 * The game as the MODEL should read it: the child's own markup, styles and
 * script, with our injected runtime removed.
 *
 * Fail-soft by construction. Anything it does not positively recognise is
 * KEPT — the cost of keeping one of our blocks is a few hundred wasted
 * tokens, while the cost of dropping one of the child's is a broken edit.
 */
export function stripInjectedRuntime(html: string): string {
  if (!html) return html;
  let out = html.replace(IMPORTMAP_RE, "");
  out = out.replace(BLOCK_RE, (block) => (isInjectedBlock(block) ? "" : block));
  out = out.replace(MARKER_RE, "");
  // Collapse the run of blank lines the removals leave behind, so the model
  // is not reading a page of whitespace. Never touches non-empty lines.
  return out.replace(/(?:[ \t]*\r?\n){3,}/g, "\n\n");
}

/** How many tokens (roughly) stripping saves — for logging and tests. */
export function strippedTokenSaving(html: string): number {
  return Math.max(0, Math.ceil((html.length - stripInjectedRuntime(html).length) / 4));
}
