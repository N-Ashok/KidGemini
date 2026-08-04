// Save & continue AFTER PUBLISHING — the prompt contract clause that makes
// save/continue survive publishing to the Arcade, not just the in-chat draft.
// Mirrors save-state-playbook.ts's shape (same file, same gate) — read that
// file's own header first, and docs/2026-08-01_PRD_SaveContinueBuilding.md §8
// ("Out of scope — published/Arcade game save state") for why this exists as
// a SEPARATE clause rather than a change to that one.
//
// The postMessage contract SAVE_STATE_PROMPT_SECTION teaches only works
// inside the sandboxed chat-preview iframe, where ArtifactFrame.tsx (parent
// frame) actively sends `{type:"ariantra:request-save"}` and injects
// `window.__ARIANTRA_INITIAL_STATE__`. A PUBLISHED game has no parent frame —
// nobody ever sends that message, so a game that implements ONLY the
// postMessage contract silently never saves once published (confirmed live,
// 2026-08-04, on a real published building game: the postMessage listener sat
// there forever, unfired). `../Ariantra-Platform/src/sdk/ariantra-sdk.ts`
// already exposes `Ariantra.confirmResume()`/`Ariantra.autosave()` for
// exactly this — a game just has to call them. This clause teaches that,
// ADDITIONALLY, never as a replacement: the in-chat draft still needs the
// postMessage contract (it's what ArtifactFrame.tsx's shipped "Continue your
// build?" banner and the durable `game_saves` DB table actually drive).
//
// Wired into buildTurnSystemInstruction() via the SAME `gates.save` as
// SAVE_STATE_PROMPT_SECTION (it's the same "this is a build/world game"
// signal — no new gate needed) — see docs/PROMPT_MANAGEMENT.md §1's
// assembly-order table and §2.5a, and docs/COST_TOKEN_BUDGET.md for the
// token line item.
//
// CACHE CONTRACT: a plain constant with no interpolation, same rule as
// SAVE_STATE_PROMPT_SECTION/PHYSICS_PROMPT_SECTION — stays byte-identical per
// turn so Gemini prefix caching keeps hitting. Pinned by test.

export const PUBLISHED_SAVE_PROMPT_SECTION = `**Save & continue also has to work AFTER PUBLISHING, not just here in chat.**
Once this game is published, it runs as its own standalone page with no chat
window around it — the save-request postMessage above will never arrive there.
Implement BOTH of the following calls too, in addition to (never instead of)
the postMessage handlers above, so the SAME build/world state survives both
here and once published:

   RESTORE AT STARTUP, NON-BLOCKING. Right after the game loop starts (never
   before it — do not await this or anything else before the loop runs):
   \`Ariantra.ready().then(() => Ariantra.confirmResume()).then(save => {
       if (save) { /* restore every area from save.areas, same shape as the
                      postMessage payload above */ }
   });\`
   \`Ariantra.confirmResume()\` already shows its own "Continue where you left off?"
   prompt when a save exists, and resolves \`null\` when there is none —
   do not build your own confirmation UI for this.

   AUTOSAVE, ONCE, AT STARTUP. Call this once, not inside the game loop:
   \`Ariantra.autosave(() => currentWorldState);\`
   \`currentWorldState\` must be the SAME \`{ areas: [...] }\` object the
   postMessage handler above builds and sends — track it as one shared
   variable so both mechanisms stay in sync instead of drifting apart.

   These calls are always safe to make — \`Ariantra\` is auto-injected on every
   surface this game ever runs on, chat preview included, so there is no need
   to detect which surface you're on.`;
