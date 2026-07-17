// Shared postMessage source/marker constants for the sandboxed game preview's
// two injected scripts — console capture (game-console.ts) and the
// self-healing verify probe (preview-verify.ts). Split out because
// preview-verify.ts already imports FROM game-console.ts
// (injectConsoleCapture), so game-console.ts can't import back without a
// cycle — the workaround used to be a hardcoded duplicate literal in each
// file instead of a shared constant, which is exactly the kind of value a
// rename can silently drift on (found during the 2026-07-17 "kidgemini" →
// "Ari" rename: game-console.ts:43 and preview-verify.ts's injection anchor
// each hardcoded a copy of the other file's constant).

export const GAME_CONSOLE_SOURCE = "ari-game-console" as const;
export const PREVIEW_VERIFY_SOURCE = "ari-preview-verify" as const;
export const PARENT_READY_SOURCE = "ari-parent" as const;

/** Marker so injectConsoleCapture is idempotent (never double-inject); also
 *  the anchor preview-verify.ts's injectPreviewInstrumentation() rides
 *  directly behind, so both scripts install before any game code. */
export const CONSOLE_CAPTURE_MARKER = "<!--ari-console-capture-->";
