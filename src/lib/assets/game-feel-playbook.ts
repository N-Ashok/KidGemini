// The game-feel playbook (2026-08-29, docs/2026-08-29_PRD_GameFeelAndMotivation.md).
//
// Owner's trigger: a turbo boost that changed a speed variable and nothing
// else — "for a turbo boost, it was pathetic." The prompt taught how to make a
// game CORRECT and nothing about making it feel like anything.
//
// Three rules, all evidenced, all cheap, all applying to every game:
//  1. Juice — with a calibration clause. Research is specific: MEDIUM and HIGH
//     juiciness beat both NONE and EXTREME on player experience, intrinsic
//     motivation, play time and in-game score. "Add lots of juice" would aim
//     at the band that measurably under-performs, so the ceiling is stated.
//  2. A cosmetic choice at the start. For ages 7–12 a task-IRRELEVANT choice
//     (pick your spaceship) measurably raised intrinsic motivation AND
//     learning. Ten lines of code; we taught nothing about it.
//  3. Live progress toward the goal — the research requires feedback to show
//     DISTANCE TO THE GOAL, not just a score.
//
// ALWAYS-ON (owner decision 2026-08-29). Keyword-gating audio left 93% of real
// games silent, and "this game feels like nothing" is just as invisible in a
// child's words as "this game has no sound" was.
//
// CACHE CONTRACT: a plain constant, no interpolation — the system prompt stays
// byte-identical per turn so Gemini prefix caching keeps hitting.

export const GAME_FEEL_PROMPT_SECTION = `**Make it feel good**: a game can be correct and still feel like nothing
happened. Three cheap things fix that.

   PUNCH. When something lands — a hit, a pickup, a boost — freeze the action
   for 3 to 5 frames, then carry on: that tiny stop is what makes an impact
   feel solid. Shake the screen a little, and scale it to the event, so a
   small bump barely wobbles and a crash really shakes. Throw a few particles
   at the point of contact. Slide and fade between screens and levels instead
   of cutting. Make buttons visibly press in. Enough that the player FEELS it,
   never so much that they cannot see what is happening — too much shake and
   flashing is worse than none at all, and it hides the game.

   LET THEM CHOOSE SOMETHING. On the start screen let the child pick their
   character, colour or hat from three or four options. It changes only how
   the game looks, never how it plays — that is the point: it is theirs now.

   SHOW HOW FAR THEY HAVE GOT. A score alone does not tell a child whether
   they are close. Show progress toward the actual goal — "12 / 50 coins",
   a filling bar, laps left, metres to go — and make it move the instant it
   changes.`;
