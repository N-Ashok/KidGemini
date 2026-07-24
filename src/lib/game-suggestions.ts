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

// ── Bible-teacher pool (owner request 2026-07-24) ────────────────────────────
// The teacher surface was showing the kid pool — dinosaurs, aliens, unicorns —
// which is the wrong prompt for someone building a Sunday-school lesson. Same
// 10 × 50 = 500 shape and the same 4-random-per-load behaviour.
//
// The mechanics are a DIFFERENT list, not the kid one. A naive cross-product
// would have produced "Make me a space shooter game with the empty tomb" —
// nonsense at best, irreverent at worst. These ten carry no combat framing and
// each reads sensibly against every theme below.
export const BIBLE_MECHANICS = [
  "journey game",
  "puzzle game",
  "maze game",
  "matching game",
  "memory game",
  "collecting game",
  "building game",
  "quiz game",
  "sorting game",
  "treasure hunt game",
] as const;

// Well-known narratives and objects suited to children's ministry. Deliberately
// omits the crucifixion and other passages that do not belong in a casual game
// frame; the resurrection appears only as the joyful "empty tomb".
const BIBLE_THEMES = [
  ["about Noah's ark", "🚢"],
  ["about the animals going two by two", "🦓"],
  ["in the Garden of Eden", "🌳"],
  ["about Jonah and the big fish", "🐋"],
  ["about David's sling", "🪨"],
  ["about Daniel in the lions' den", "🦁"],
  ["about Moses parting the sea", "🌊"],
  ["about the Ten Commandments", "📜"],
  ["about Joseph's colourful coat", "🧥"],
  ["in Solomon's temple", "🏛️"],
  ["about the Tower of Babel", "🗼"],
  ["about the walls of Jericho", "🧱"],
  ["about manna from heaven", "🍞"],
  ["about the burning bush", "🔥"],
  ["about the good shepherd", "🐑"],
  ["about the lost sheep", "🐏"],
  ["about the Good Samaritan", "❤️"],
  ["about the loaves and the fishes", "🐟"],
  ["about the star of Bethlehem", "⭐"],
  ["about the wise men's gifts", "🎁"],
  ["in Bethlehem", "🏘️"],
  ["about Noah's rainbow", "🌈"],
  ["about the dove and the olive branch", "🕊️"],
  ["about Abraham counting the stars", "✨"],
  ["about Jacob's ladder", "🪜"],
  ["about crossing the river Jordan", "🏞️"],
  ["about Elijah's chariot", "🐎"],
  ["about Ruth in the barley field", "🌾"],
  ["about Esther in the palace", "👑"],
  ["about Nehemiah rebuilding the wall", "🧰"],
  ["about the prodigal son coming home", "🏃"],
  ["about the mustard seed", "🌱"],
  ["about the pearl of great price", "🦪"],
  ["about the wise and foolish builders", "🏠"],
  ["about the ten lamps", "🪔"],
  ["about Zacchaeus in the tree", "🌴"],
  ["about becoming fishers of men", "🎣"],
  ["about Paul's shipwreck", "⛵"],
  ["about the armour of God", "🛡️"],
  ["about the fruit of the Spirit", "🍇"],
  ["about Samuel hearing his name", "🔔"],
  ["about Gideon's trumpets", "🎺"],
  ["about Joshua marching", "🥁"],
  ["about the ark of the covenant", "📦"],
  ["about Miriam's tambourine", "🪘"],
  ["about Deborah under the palm tree", "🌳"],
  ["about the widow's two coins", "🪙"],
  ["about the sower scattering seed", "🚜"],
  ["about Bartimaeus seeing again", "👁️"],
  ["about the empty tomb at sunrise", "🌅"],
] as const;

export const BIBLE_GAME_SUGGESTIONS: readonly string[] = Object.freeze(
  BIBLE_MECHANICS.flatMap((mechanic) =>
    BIBLE_THEMES.map(([theme, emoji]) => `Make me a ${mechanic} ${theme} ${emoji}`),
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
  // Must match the pool: grouping by the WRONG mechanics list silently degrades
  // to one-group-per-suggestion, and the round-robin (the whole point) stops
  // working — you get four quiz games again.
  mechanics: readonly string[] = MECHANICS,
): string[] {
  const groups = new Map<string, string[]>();
  for (const s of pool) {
    const key = mechanics.find((m) => s.includes(m)) ?? s;
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

/**
 * The 4 starter chips for a surface. Keeps the pool and its mechanics list
 * paired — the one thing a caller can get wrong (see pickSuggestions' note).
 */
export function suggestionsFor(
  persona: "bible-teacher" | undefined,
  count = 4,
  rand: () => number = Math.random,
): string[] {
  return persona === "bible-teacher"
    ? pickSuggestions(count, rand, BIBLE_GAME_SUGGESTIONS, BIBLE_MECHANICS)
    : pickSuggestions(count, rand, GAME_SUGGESTIONS, MECHANICS);
}
