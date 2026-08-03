// Save & continue building — the prompt contract clause
// (docs/2026-08-01_PRD_SaveContinueBuilding.md §3a). Mirrors
// physics-playbook.ts's shape: a plain constant teaching the model a
// protocol, gated on the game actually needing it.
//
// Wired into buildTurnSystemInstruction() via `gates.save`
// (src/lib/assets/catalog-gate.ts) as of Phase 2, 2026-08-03 — see
// docs/PROMPT_MANAGEMENT.md §2.5 and §1's assembly-order table, and
// docs/COST_TOKEN_BUDGET.md for the token line item.
//
// CACHE CONTRACT: a plain constant with no interpolation, same rule as
// PHYSICS_PROMPT_SECTION — it stays byte-identical per turn so Gemini prefix
// caching keeps hitting. Pinned by test.

export const SAVE_STATE_PROMPT_SECTION = `**Save & continue building**: this game has meaningful build/world state
worth persisting (placed blocks, a score, an inventory) — implement the save
contract so a kid can leave and come back to the same in-progress state.

   REPLY TO SAVE REQUESTS. Listen for
   \`window.addEventListener("message", (e) => { if (e.data?.type ===
   "ariantra:request-save") { ... } })\` and reply with
   \`parent.postMessage({ type: "ariantra:save-state", payload }, "*")\`.

   SAVE THE WHOLE WORLD, NOT THE CURRENT VIEW. \`payload\` must represent
   everything the player has ever built, not just what is on screen or the
   area they are currently standing in. For a single build area that is a
   flat list of placed objects; for a game where the player can travel and
   build in multiple distinct areas (a "build your universe" style game),
   \`payload\` must list EVERY area the player has built in, each keyed by its
   own id and world coordinates, e.g.:
   \`{ "areas": [
       { "id": "city-1", "originX": 100, "originZ": 200,
         "objects": [{ "type": "block", "x": 12, "y": 0, "z": 4, "rotation": 0 }] },
       { "id": "city-2", "originX": 5000, "originZ": 8000, "objects": [] }
   ] }\`
   Do NOT default to saving only the area the player happens to be in when
   the request arrives — that silently loses every other area on restore.
   Each object needs its own position (and rotation/type/color/whatever else
   defines it) so restore can place it back exactly.

   RESTORE ON BOOT. Before building the default/starting world, check
   \`window.__ARIANTRA_INITIAL_STATE__\` — if it is set, restore EVERY area
   from it (not just the closest one to spawn) instead of starting fresh.

   EMIT THE MARKER. Put \`<!--SUPPORTS_SAVE-->\` at the top of \`<body>\` if, and
   only if, both the save-reply handler and the boot-time restore are
   actually implemented — this is what turns save/continue on for the
   player; never emit it as a courtesy without the code behind it.`;
