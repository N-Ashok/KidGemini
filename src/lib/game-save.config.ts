// Save & continue building — tunables (docs/2026-08-01_PRD_SaveContinueBuilding.md §6, §3c).

/** stateJson size cap. 1.5MB, not the 200KB first floated — a multi-area
 *  "build your universe" world accumulates one entry per object across every
 *  area the kid has ever built, and undercapping means a kid's second or
 *  third city silently stops saving while the first keeps working, which is
 *  a worse and more confusing failure than a single clear limit (PRD §6). */
export const MAX_STATE_JSON_BYTES = 1_500_000;

/** Server-side debounce: at most one write per message per this window,
 *  guarding against a misbehaving client hammering the write path (PRD §3c).
 *  The client-side autosave interval below is a separate, larger cadence. */
export const WRITE_DEBOUNCE_MS = 15_000;

/** Client-side autosave cadence (PRD §3c): while the artifact is mounted and
 *  the tab is visible, request the game's state on this interval. Larger
 *  than WRITE_DEBOUNCE_MS on purpose — the server debounce is a safety net
 *  against a misbehaving client, not the primary pacing mechanism. */
export const AUTOSAVE_INTERVAL_MS = 30_000;
