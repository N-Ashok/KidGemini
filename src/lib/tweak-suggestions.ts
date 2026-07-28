// "Continue THIS game" suggestion pool (BUG-FIX-LOG 2026-07-28, kid report:
// "in the memory game with turtle, after an edit very unrelated suggestions").
//
// Why this file exists at all: the next-ask fallback originally reused
// game-suggestions.ts's starter pool, whose 500 entries are ALL of the shape
// "Make me a {mechanic} game {theme}". Those exist for the BLANK first-message
// screen — their whole job is to START a brand-new game. Served as "what to
// try next" on a game the kid is already building, they read as nonsense
// ("Make me a flying game with monkeys 🐵" under a turtle memory game) and are
// actively destructive: tapping one abandons the game they were working on.
//
// Every entry here instead makes sense for ANY existing game, phrased the way
// a KID would say it to Ari. Generic by design — the CONTEXTUAL suggestions
// come from the model itself on fresh-build turns (next-ask-sentinel.ts); this
// pool is the safety net for turns where that isn't available (edit/patch
// turns, or a malformed model reply).

export const TWEAK_SUGGESTIONS: readonly string[] = Object.freeze([
  "Add a power-up I can collect ⭐",
  "Make it a little faster",
  "Make it a little easier",
  "Add sound effects 🔊",
  "Add a second level",
  "Add a start screen with my game's name",
  "Add a timer ⏱️",
  "Show a high score",
  "Add a big celebration when I win 🎉",
  "Change the colors to my favourites 🎨",
  "Make the background prettier",
  "Let me pick my character",
  "Make it get harder the longer I play",
  "Add a bonus round",
  "Hide a secret surprise somewhere",
  "Make the buttons bigger for my tablet",
  "Add a restart button",
  "Add a fun sound when I score",
  "Add a friendly helper character",
  "Make the winning screen more exciting",
  "Add a pause button",
  "Give me three lives ❤️",
  "Add a countdown before it starts",
  "Make the characters bigger",
]);

// Bible-teacher variant — same "change THIS game" spirit, but written for a
// teacher preparing a lesson for their class (matches the persona split that
// game-suggestions.ts and imagination-hints.ts already use).
export const BIBLE_TWEAK_SUGGESTIONS: readonly string[] = Object.freeze([
  "Add a Bible verse when the child wins",
  "Add a gentle sound when they get it right 🔊",
  "Add a second level with a new part of the story",
  "Add a start screen with the lesson's title",
  "Show a score so the class can play in teams",
  "Add a celebration when they finish 🎉",
  "Make the pictures bigger for the classroom screen",
  "Add a restart button for the next child",
  "Make it a little easier for younger children",
  "Add a short line explaining the story",
  "Add a kind message when they get it wrong",
  "Let the child choose their character",
]);

/** Pick `count` distinct suggestions. `rand` is injectable for deterministic
 *  tests, same contract as game-suggestions.ts's pickSuggestions. */
export function pickTweakSuggestions(
  count = 2,
  rand: () => number = Math.random,
  pool: readonly string[] = TWEAK_SUGGESTIONS,
): string[] {
  const remaining = [...pool];
  const picks: string[] = [];
  while (picks.length < count && remaining.length > 0) {
    picks.push(remaining.splice(Math.floor(rand() * remaining.length), 1)[0]!);
  }
  return picks;
}
