// Starter-chip suggestion pool. The chat shows 4 random picks per load so kids
// don't see the same four every time (user request 2026-07-08). The pool is
// built from 10 game mechanics × 50 themes = 500 deterministic, kid-friendly
// prompts — every one starts a GAME (product decision 2026-07-07: this is a
// game-making platform, so every starter is a game).

export const MECHANICS = [
  "racing game",
  "jump-and-run game",
  "puzzle game",
  "maze game",
  "catching game",
  "memory game",
  "space shooter game",
  "flying game",
  "building game",
  "treasure hunt game",
] as const;

const THEMES = [
  ["with dinosaurs", "🦖"],
  ["with aliens", "👾"],
  ["with robots", "🤖"],
  ["with pirates", "🏴‍☠️"],
  ["with unicorns", "🦄"],
  ["with dragons", "🐉"],
  ["with cats", "🐱"],
  ["with dogs", "🐶"],
  ["with penguins", "🐧"],
  ["with monkeys", "🐵"],
  ["with sharks", "🦈"],
  ["with butterflies", "🦋"],
  ["with bees", "🐝"],
  ["with frogs", "🐸"],
  ["with pandas", "🐼"],
  ["with lions", "🦁"],
  ["with owls", "🦉"],
  ["with an octopus", "🐙"],
  ["with turtles", "🐢"],
  ["with bunnies", "🐰"],
  ["with superheroes", "🦸"],
  ["with ninjas", "🥷"],
  ["with wizards", "🧙"],
  ["with astronauts", "🧑‍🚀"],
  ["with mermaids", "🧜"],
  ["with fairies", "🧚"],
  ["with friendly ghosts", "👻"],
  ["with snowmen", "⛄"],
  ["with candy", "🍭"],
  ["with pizza", "🍕"],
  ["with ice cream", "🍦"],
  ["with fruit", "🍎"],
  ["with vegetables", "🥕"],
  ["with fast cars", "🏎️"],
  ["with trains", "🚂"],
  ["with rockets", "🚀"],
  ["with submarines", "🤿"],
  ["with airplanes", "✈️"],
  ["with balloons", "🎈"],
  ["with shooting stars", "⭐"],
  ["with rainbows", "🌈"],
  ["in a volcano", "🌋"],
  ["in the jungle", "🌴"],
  ["under the sea", "🌊"],
  ["in a castle", "🏰"],
  ["on a farm", "🚜"],
  ["with soccer balls", "⚽"],
  ["with basketballs", "🏀"],
  ["with music notes", "🎵"],
  ["with hidden gems", "💎"],
] as const;

export const GAME_SUGGESTIONS: readonly string[] = Object.freeze(
  MECHANICS.flatMap((mechanic) =>
    THEMES.map(([theme, emoji]) => `Make me a ${mechanic} ${theme} ${emoji}`),
  ),
);

/** Pick `count` distinct random suggestions, round-robining across game
 *  MECHANICS so one load never shows the same game type twice (a pure random
 *  draw gave "three jump-and-runs" loads). `rand` is injectable for tests;
 *  the UI calls it with the default Math.random. */
export function pickSuggestions(
  count = 4,
  rand: () => number = Math.random,
  pool: readonly string[] = GAME_SUGGESTIONS,
): string[] {
  const groups = new Map<string, string[]>();
  for (const s of pool) {
    const key = MECHANICS.find((m) => s.includes(m)) ?? s;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  // Randomize the group order, then take one random entry per group in turn.
  const order: string[][] = [];
  const unplaced = [...groups.values()];
  while (unplaced.length > 0) {
    order.push(unplaced.splice(Math.floor(rand() * unplaced.length), 1)[0]!);
  }
  const picks: string[] = [];
  let turn = 0;
  while (picks.length < count) {
    const live = order.filter((g) => g.length > 0);
    if (live.length === 0) break;
    const g = live[turn % live.length]!;
    picks.push(g.splice(Math.floor(rand() * g.length), 1)[0]!);
    turn++;
  }
  return picks;
}
