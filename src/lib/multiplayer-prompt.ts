// The multiplayer section of the game-build system prompt (PRD-MULTIPLAYER.md
// Phase 4, Ariantra-Platform repo). Kept separate from assets/prompt-catalog.ts
// on purpose — this isn't an asset catalog (models/sounds), it's a game-
// mechanic/SDK teaching block, gated independently (multiplayer-gate.ts).
//
// Load-bearing correction (Phase 3, Ariantra-Platform): the platform's
// injected lobby overlay — not the kid's game code — owns host()/join(), since
// the SDK has exactly one active session and two independent callers would
// race for it. The game only ever needs broadcast()/onMessage()/onPlayers().
// Getting this wrong means the model writes its own host()/join() calls that
// conflict with the overlay the moment both exist — multiplayer-prompt.test.ts
// pins this contract.

export const MULTIPLAYER_PROMPT_SECTION = `**Optional real-time multiplayer**: for a game built to be played by 2+
people at once (racing against a friend, a versus/co-op game), the platform
connects players together and shows its own invite/lobby screen automatically
— you never see or write any networking, invite, or lobby code yourself.
1. Put the single line \`<!--USES_MULTIPLAYER-->\` as the very first thing
   inside \`<body>\` (alongside any other opt-in marker lines this game
   already uses) — this is how the platform knows to show its "Play together"
   invite/lobby screen before the game starts. Leave it out for single-player
   games.
2. Never call \`Ariantra.host()\` or \`Ariantra.join()\` yourself, and never
   build your own lobby, invite screen, or "waiting for player 2" message —
   the platform's own overlay already does all of that before your game code
   even runs. Writing your own would fight the platform's overlay for the
   same session.
3. Your game only ever needs three calls:
   \`Ariantra.broadcast({ ... })\` — send your player's move/state to every
   other connected player. Send small plain objects only (position, score, an
   action name) — never functions or large data.
   \`Ariantra.onMessage((data, fromPlayerId) => { ... })\` — apply another
   player's move/state to your game exactly like you'd apply your own.
   \`Ariantra.onPlayers((players) => { ... })\` — \`players.length\` tells you
   how many are connected right now; use it to wait for a second player
   before starting a race/round if the game needs that.
4. Host-authoritative pattern: treat one player's copy of the game (it does
   not matter which one) as the source of truth for anything shared, like
   where an obstacle spawns or who won. Broadcast state changes from wherever
   your game loop already changes them, and apply incoming messages the same
   way you'd apply a local change.
5. The game must work, alone, before a friend joins — start it immediately
   like every other game; multiplayer moves simply start arriving once
   someone else connects.`;
