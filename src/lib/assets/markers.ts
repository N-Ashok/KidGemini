// Asset markers — the single source of truth for the comment tokens the model
// emits and the injector consumes. Pure string/regex only (NOT server-only), so
// it can be shared by inject.ts (server) AND the edit-patch reconciliation
// (game-edit.ts / api/chat route) without dragging server-only into a pure path.
//
// Why this module exists (BUG-FIX-LOG 2026-07-20, KNOWN_BUGS #5): injectAssets
// STRIPS these markers out of the delivered game (they resolve into an import
// map + AR_ASSETS table). So the stored source the model later edits has NO
// markers — but the model, told by the 3D/asset prompt sections to always emit
// `<!--USES_MODELS: …-->` at the top, re-writes it into its SEARCH block. The
// SEARCH text then can't be found in the marker-stripped source
// (`inSource=false`), the patch fails, and the turn escalates to a full,
// expensive regeneration. Reconciling the markers out of the SEARCH — exactly
// as injection removed them — restores the match for the common asset-game edit.

/** Emitted as the very first thing in <body> when the model builds with Three.js. */
export const THREE_MARKER = "<!--USES_THREE-->";

/** Emitted when the game needs REAL rigid-body physics (2026-07-29). Maps the
 *  "cannon-es" bare specifier in the import map, same contract as USES_THREE. */
export const PHYSICS_MARKER = "<!--USES_PHYSICS-->";

/** Emitted when a build/world game implements the save & continue building
 *  contract (docs/2026-08-01_PRD_SaveContinueBuilding.md §3a) — ONLY when
 *  both the save-reply postMessage handler and the boot-time restore are
 *  actually implemented. Never stripped by injectAssets (it isn't an asset
 *  marker), so it's a plain string, not part of stripAssetMarkers/hasAssetMarker. */
export const SUPPORTS_SAVE_MARKER = "<!--SUPPORTS_SAVE-->";

/** `<!--USES_MODELS: car, tree-->` — names resolve through the manifest. */
export const MODELS_MARKER_RE = /<!--USES_MODELS:([a-z0-9_,\s]*)-->/gi;

/** `<!--USES_AUDIO: coin_pickup, bg_loop_upbeat-->` — same resolution rules. */
export const AUDIO_MARKER_RE = /<!--USES_AUDIO:([a-z0-9_,\s]*)-->/gi;

/**
 * Removes every asset marker from `text`, byte-for-byte the same way
 * injectAssets does (marker text gone, surrounding whitespace untouched) — so a
 * marker-stripped SEARCH block matches the marker-stripped stored source exactly.
 * A game with no markers passes through unchanged (=== identity).
 */
export function stripAssetMarkers(text: string): string {
  return text
    .split(THREE_MARKER).join("")
    .split(PHYSICS_MARKER).join("")
    .replace(MODELS_MARKER_RE, "")
    .replace(AUDIO_MARKER_RE, "");
}

/** True when `text` contains any asset marker (the reconciliation only fires
 *  when there's a marker to reconcile). Defined via stripAssetMarkers so the
 *  two can never disagree about what counts as a marker. */
export function hasAssetMarker(text: string): boolean {
  return stripAssetMarkers(text) !== text;
}

/**
 * Display-safe variant for KID-FACING PROSE ONLY (BUG-FIX-LOG 2026-07-28).
 * Markers are internal instructions to our own asset injector; a child should
 * never read one. They are invisible inside game CODE (an HTML comment), but
 * when the model writes one above its patch instead of inside the document it
 * lands in the chat bubble as literal `<!--USES_AUDIO: pop, chime-->` text,
 * which reads to a 7-year-old as "I broke it".
 *
 * Differs from stripAssetMarkers in also dropping a marker that is still
 * ARRIVING — an unterminated `<!--…` tail mid-stream, which the complete-marker
 * regexes cannot match by definition. NEVER use this for source manipulation:
 * there an unterminated comment must survive byte-for-byte, and dropping a
 * trailing fragment would corrupt the game.
 */
export function stripAssetMarkersForDisplay(text: string): string {
  return stripAssetMarkers(text)
    .replace(/<!--(?:(?!-->)[\s\S])*$/, "")
    .trimEnd();
}

/** Every asset NAME referenced by USES_MODELS / USES_AUDIO markers in `text`
 *  (lower-cased, de-duped). USES_THREE carries no name — the engine is implied. */
export function assetMarkerNames(text: string): string[] {
  const names: string[] = [];
  for (const re of [MODELS_MARKER_RE, AUDIO_MARKER_RE]) {
    re.lastIndex = 0; // global regex: matchAll clones, but be explicit
    for (const m of text.matchAll(re)) {
      for (const raw of (m[1] ?? "").split(",")) {
        const name = raw.trim().toLowerCase();
        if (name && !names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

/** True when `html` has already been through injectAssets — it carries an
 *  injected import map and/or an AR_ASSETS table. Distinguishes an asset game
 *  whose markers injection stripped (safe to reconcile) from a plain 2D game
 *  where a marker in the reply is a genuine NEW request (must not be stripped). */
export function looksInjected(html: string): boolean {
  return html.includes("window.AR_ASSETS") || /<script[^>]*type=["']importmap["']/i.test(html);
}

/** The asset names already baked into a delivered game — the keys of the
 *  injected `window.AR_ASSETS={…}` table. Used to tell an INERT marker (naming
 *  an asset the game already has) apart from a NEW-asset request (which needs a
 *  real re-injection, so it must NOT be silently stripped). */
export function arAssetsKeys(html: string): string[] {
  const m = html.match(/window\.AR_ASSETS\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!m) return [];
  try {
    return Object.keys(JSON.parse(m[1]!));
  } catch {
    return [];
  }
}
