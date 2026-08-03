// Save & continue building — injects the restored state before the game's
// own script runs (docs/2026-08-01_PRD_SaveContinueBuilding.md §3f). Same
// marker+anchor+escape shape as preview-runtime.ts's injectPreviewRuntime:
// a kept-separate module (not folded into preview-runtime.ts) because this
// injection is conditional on the kid's own "Continue your build?" choice,
// not run unconditionally on every preview like the SDK bundle is — mixing
// the two would make the always-on runtime's cache/idempotency story depend
// on a value that changes per session (SRP).

import { escapeForInlineScript, insertEarly } from "./assets/runtime-helpers";
import type { GameSaveState } from "@/types/game-save.types";

/** Idempotency marker (same pattern as PREVIEW_RUNTIME_MARKER). */
export const INITIAL_GAME_STATE_MARKER = "<!--ari-initial-game-state-->";

/** Prepend `window.__ARIANTRA_INITIAL_STATE__ = state` to `html`, as early as
 *  possible (after `<head>`, else `<html>`, else prepended) so the game's own
 *  boot code — taught by SAVE_STATE_PROMPT_SECTION to check this global — can
 *  read it before building its default/starting world. Idempotent: a second
 *  call is a no-op, same contract as injectPreviewRuntime. */
export function injectInitialGameState(html: string, state: GameSaveState): string {
  if (html.includes(INITIAL_GAME_STATE_MARKER)) return html;
  const json = escapeForInlineScript(JSON.stringify(state));
  const block = `${INITIAL_GAME_STATE_MARKER}<script>window.__ARIANTRA_INITIAL_STATE__=${json};</script>`;
  return insertEarly(html, block);
}
