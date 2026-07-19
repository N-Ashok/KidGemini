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

export const MULTIPLAYER_PROMPT_SECTION = `**Optional real-time multiplayer**: for a game built to be played by 2-5
people at once (racing against a friend, a versus/co-op game), the platform
connects players together and shows its own invite/lobby screen automatically
— you never see or write any networking, invite, or lobby code yourself. A
room needs at least 2 players to start and never has more than 5 — you can
mention this in your own UI copy ("waiting for a friend (2-5 players)") but
never enforce it yourself; the platform's lobby already rejects a 6th joiner.
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
3. Six calls cover everything a multiplayer game needs:
   \`Ariantra.myPlayerId()\` — your OWN player id, or \`null\` before a
   session exists. Never invent your own random id — compare
   \`players[i].playerId === Ariantra.myPlayerId()\` wherever the game needs
   to tell its own roster row, avatar, or car apart from a peer's.
   \`Ariantra.onPlayers((players) => { ... })\` — fires with the live roster
   any time it changes; \`players.length\` tells you how many are connected.
   Each entry is \`{ playerId, isHost, joinedAt, displayName? }\` — the id
   field is \`playerId\`, never \`id\`. \`displayName\` is the player's REAL
   chosen name when they set one — always prefer it for on-screen labels
   ("Aanya wins!"); only fall back to something like "Player 2" (by sorted
   roster position) when it's absent. Never label a peer with a generic word
   like "Friend" — either show their real name or a numbered fallback.
   Re-run ALL layout/positioning derived from \`players\` every time this
   fires, not just once at page load — a player who joins after your first
   render still needs a starting position, spawn slot, or avatar created for
   them at that moment, not left at whatever default (like \`{x:0,y:0}\`) your
   code happened to initialize it to. Every player gets a DIFFERENT starting
   slot derived from their index in the roster (sorted by \`joinedAt\` or
   \`playerId\` so all copies agree) — never spawn two players at the same
   spot: identical coordinates also break the push-apart collision math in
   rule 6 (distance zero → division by zero).
   \`Ariantra.broadcast({ ... })\` / \`Ariantra.onMessage((data, fromPlayerId)
   => { ... })\` — for DISCRETE one-off events only: a win, an item pickup, a
   round starting, a chat ping. Applied the instant they arrive.
   \`Ariantra.broadcastState({ ... })\` / \`Ariantra.getPeerState(peerId)\` —
   for CONTINUOUSLY-changing values instead (position, rotation, speed —
   anything your game loop updates every frame). Call \`broadcastState\`
   every frame with your own player's current numeric fields; call
   \`getPeerState(peerId)\` every frame to read a peer's value back (returns
   \`null\` until their first update arrives). The platform automatically
   smooths what \`getPeerState\` returns to hide real network jitter/latency
   — using plain \`broadcast\`/\`onMessage\` for continuous movement instead
   makes it visibly stutter and rubber-band under real-world latency, so
   always prefer \`broadcastState\`/\`getPeerState\` for anything that moves
   every frame.
4. Host-authoritative pattern: treat one player's copy of the game (it does
   not matter which one) as the source of truth for anything shared, like
   where an obstacle spawns or who won. Broadcast state changes from wherever
   your game loop already changes them, and apply incoming messages the same
   way you'd apply a local change.
5. Winning/game-over MUST be explicit and MUST reach every player — never let
   it be a purely local computation one player silently reaches. The moment
   any player detects the end condition, \`Ariantra.broadcast({ type:
   'gameOver', ... })\` it immediately, and show your result screen (winner
   name, "you win"/"you lose", a "play again" button) from ONE shared
   function that runs identically whether it's your own local detection or an
   incoming \`onMessage\` for that same event — a kid should never be able to
   report "it never says who won."
6. If players can physically collide (racing, bumping, arena games), treat
   every player's position as solid, not a ghost another player passes
   through: each frame, check the distance between your player and each peer
   (from \`getPeerState\`); if they overlap, push your position apart along
   the line between the two centers (move away by however much they overlap)
   instead of leaving them stacked or letting them cross over each other.
   Guard the division: when the distance is exactly zero (two cars on the
   same point — e.g. right after a shared spawn or reset), dividing the
   offset by it produces NaN, which poisons the position and camera until
   the screen shows nothing but the background color — in that case push in
   a fixed direction (or skip the push that frame) instead of dividing.
7. The game must work, alone, before a friend joins — start it immediately
   like every other game; multiplayer moves simply start arriving once
   someone else connects.
8. One session hosts MANY rounds — friends play round after round without
   re-inviting. Never reload the page to restart (\`location.reload()\`, or
   setting \`location.href\`, disconnects the player from the friend session
   and kills the rematch): the "play again" button must instead reset the
   game in code — positions, scores, timers, obstacles back to their starting
   values — and \`Ariantra.broadcast({ type: 'restart' })\` so every player
   resets together, applied through the same shared reset function whether it
   was your own button press or an incoming \`onMessage\` (the exact contract
   rule 5 uses for game-over). Inside that reset, re-derive EVERY player's
   spawn position and the camera from the CURRENT roster (the same layout
   logic your \`onPlayers\` handler runs) — \`onPlayers\` does NOT fire again
   on restart because nobody joined or left, so a reset that skips its own
   car/camera placement leaves that player staring at an empty scene (a
   real bug report: the second player's screen went solid blue after a
   rematch while the first player could still see both cars).
9. The \`Ariantra\` SDK always exists — the platform loads it before your code
   runs, in the preview and on the published page alike. NEVER write a
   polyfill, stub, mock, or "local fallback" for it, and never assign to
   \`window.Ariantra\`: your stub would silently replace the live connection
   and every player would play alone while the lobby still looks fine. Before
   a friend connects the real calls already behave sensibly (\`myPlayerId()\`
   is \`null\`, \`getPeerState\` returns \`null\`, broadcasts are no-ops) — use
   them directly, unconditionally.`;
