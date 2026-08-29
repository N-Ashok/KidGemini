// The procedural-generation playbook (2026-08-29).
//
// Owner ask, after reading how Minecraft, No Man's Sky, Dead Cells and
// Spelunky build content: "see how do we prompt better to get this?". The
// prompt taught nothing about generating content — the only nearby rule was
// "store repeated data in a JS ARRAY", which produces fifty HAND-TYPED levels:
// a wall of output tokens, and exactly the shape that made builds truncate
// (BUG-FIX-LOG 2026-07-22). A generator is ~30 lines and yields fifty or five
// hundred, so this clause should make level-rich games CHEAPER and more
// reliable, not just more varied.
//
// The four rules below are chosen for our constraints, not for fidelity to
// those games: one-shot generation, a single self-contained file, and a floor
// that a 7-year-old must be able to win. That is why the path-first rule
// (Spelunky's — solvable BY CONSTRUCTION) is taught rather than cellular
// automata or noise, which are known to produce disconnected or unjumpable
// maps and would need a verification pass we cannot rely on a one-shot model
// to write correctly.
//
// CACHE CONTRACT: a plain constant with no interpolation — it cannot vary with
// the child's message, so the system prompt stays byte-identical per turn and
// Gemini prefix caching keeps hitting (same rule as PHYSICS_PROMPT_SECTION and
// SPORTS_PLAYBOOK). Pinned by procgen-playbook.test.ts PG.7.
//
// Scale ceiling: ~600 tokens, enforced by PG.8. It rides only gated turns, but
// `levels?` fires often, so the ceiling is what keeps that affordable.

export const PROCGEN_PROMPT_SECTION = `**Levels that build themselves**: when a game has levels, stages, waves or a
world, write a RULE that makes them, not the levels themselves. Fifty
hand-typed levels is a wall of data you will not finish; a generator is thirty
lines and gives five hundred.

   DIFFICULTY IS A FORMULA. Derive each level's numbers from its index —
   \`speed = 4 + level * 0.6\`, \`spawnEvery = Math.max(0.4, 1.8 - level * 0.08)\`,
   \`gapWidth = Math.max(90, 170 - level * 5)\`. Clamp every one with min/max so
   level 40 is hard, not impossible. This is what lets a child ask for "more
   levels" forever.

   SAME SEED, SAME LEVEL. Never use bare \`Math.random()\` for layout — the
   child's level 3 must look the same every time they play it. Seed a tiny
   generator from the level number:
   \`function rng(s){return function(){s=s+0x6D2B79F5|0;var t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}\`
   then \`var rand = rng(level * 7919 + 12345);\` and use \`rand()\` everywhere
   instead of \`Math.random()\` — which is then only for sparkles and other
   things nobody needs to see twice.

   CARVE THE PATH FIRST, DECORATE AFTER. The rule that stops a generated
   level being impossible: pick the route from the start to the goal FIRST —
   step by step, using \`rand()\` to choose left/right/up — and mark those tiles
   guaranteed-walkable. Only THEN scatter obstacles, enemies and rewards into
   the tiles you did not mark, and never block a marked tile. A level built
   this way cannot be unwinnable, so you never have to test it.

   PIECES, NOT STATIC. Write four to six small hand-made chunks — a jump, a
   stair, a pit with a bridge, a coin arc — and pick between them with
   \`rand()\`. Randomising every single tile makes noise a child cannot read.

   NEVER LOCK UP. If you retry until something fits, cap it —
   \`for (var tries = 0; tries < 50; tries++) { ... }\` — and fall back to a
   simple known-good layout. An uncapped retry loop freezes the whole page,
   and the game must still start instantly and synchronously.

   THE SAFETY FLOOR STILL APPLIES to everything the generator places: nothing
   may touch the player in the first 3 seconds, the player spawns clear of
   every hazard, there is always an escape move, and every gap must be
   narrower than the player can actually jump. Check as you place, not after.`;
