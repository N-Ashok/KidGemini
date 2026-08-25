// The game as the MODEL should read it — 2026-08-25 PRD_EditTurnCost §4.A2.
//
// What a child's game looks like when we deliver it (toDeliverable in
// api/chat/route.ts → injectAssets + ensureAssetRuntime) is the child's code
// PLUS ~35k chars of runtime we inject: the loadModel helper module, the WebGL
// context guard, the perf probe, the frame governor, the AR_* lookup tables,
// the import map, the canvas-floor style. Every edit turn used to send that
// whole document back to the model as "the current source" — ~10k tokens of
// byte-identical boilerplate the model neither needs (the prompt teaches
// loadModel/AR_ASSETS by name) nor may edit, billed at the full input rate on
// every turn and never cached (it rides inside the mutating game block).
//
// This strips EXACTLY the blocks injection adds. Each signature below is the
// one the injectors themselves use to recognise their own block on
// re-injection (ensure-runtime.ts / inject.ts stripInjectedHelperBlocks /
// runtime-helpers.ts strip*Tables), so the view can never drift from what
// delivery re-adds. Whole <script>/<style> elements are removed and the bytes
// around them are untouched — so any SEARCH block the model copies from the
// view still matches the delivered document applyPatch patches (pinned by
// model-view.test.ts MV.3). Pure; no server-only import so the edit path's
// tests can use it.

const SCRIPT_BLOCK_RE = /<script[^>]*>[\s\S]*?<\/script>/g;
const IMPORTMAP_RE = /<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;
const CANVAS_FLOOR_RE = /<style>\/\*ari-3d-canvas-floor\*\/[\s\S]*?<\/style>/g;
/** The perf probe's own placement marker (`<!--ari-perf-probe-->`), left
 *  beside its script by delivery. */
const PROBE_MARKER_RE = /<!--ari-perf-probe-->/g;

/** Same assignment-only test as inject.ts stripInjectedHelperBlocks: `=(?!=)`
 *  so a child's `typeof window.loadModel === 'function'` guard survives
 *  (BUG-FIX-LOG 2026-08-20). */
const HELPER_ASSIGN_RE = /window\.(loadModel|loadModelBatch|playSound)\s*=(?!=)/;
const TABLE_RE = /window\.AR_(ASSETS|SIZES|AXES|EDGES|FACING|REAL|PARTS)\s*=(?!=)/;
const RUNTIME_SIGNATURES = ["window.__arGlGuard", "__arFrameGovernor", "__arPerfProbeVersion", 'getElementById("ar-credits")'];

function isInjectedScript(block: string): boolean {
  return HELPER_ASSIGN_RE.test(block) || TABLE_RE.test(block) || RUNTIME_SIGNATURES.some((s) => block.includes(s));
}

/** The delivered document minus everything delivery injected. Byte-identical
 *  for a game that carries no injected runtime (plain 2D). */
export function modelViewOf(html: string): string {
  return html
    .replace(IMPORTMAP_RE, "")
    .replace(CANVAS_FLOOR_RE, "")
    .replace(PROBE_MARKER_RE, "")
    .replace(SCRIPT_BLOCK_RE, (block) => (isInjectedScript(block) ? "" : block));
}
