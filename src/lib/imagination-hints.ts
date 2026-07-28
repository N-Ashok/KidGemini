// Imagination-spark pool (2026-07-28, PRD Game/docs/2026-07-27_PRD_KidHintsAndNextBestAsk.md
// §6.7): open-ended "what if" prompts, deliberately SEPARATE from
// game-suggestions.ts's mechanic pool. The idle/next-ask mechanic chip offers
// a concrete, buildable next step ("add a boss"); this pool instead asks
// about the game's THEME/STORY/WORLD — meant to spark a kid's imagination,
// not just add a feature. Used as the fallback source (next-ask-hints.ts)
// whenever the model's own contextual NEXT_ASKS line isn't available.

export const IMAGINATION_HINTS: readonly string[] = Object.freeze([
  "What if the whole game happened underwater? 🌊",
  "What if your character had a secret power they didn't know about yet? ✨",
  "What if the 'bad guy' wasn't bad at all, just misunderstood?",
  "If your game had a theme song, what would it sound like?",
  "What if it was always nighttime in your game, with glowing stars? 🌙",
  "What if your character could shrink down tiny for one level?",
  "What if the whole world was made of candy? 🍬",
  "What if there was a hidden twin character nobody expects?",
  "What if your game took place inside a giant's house?",
  "What if the sky rained something silly instead of water?",
  "What if your hero had a talking pet sidekick?",
  "What if the game had a surprise plot twist halfway through?",
  "What if everything in your game was upside down? 🙃",
  "What if your character woke up with no memory of who they are?",
  "What if the villain used to be the hero's best friend?",
  "What if your game took place in the clouds instead of on the ground? ☁️",
  "What if there was a secret door that leads to a bonus world?",
  "What if your character could talk to animals?",
  "What if the whole game was set in a dream?",
  "What if your hero's biggest weakness became their biggest strength?",
  "What if the game had a season that changes as you play — spring, then snow? ❄️",
  "What if your character's shadow came to life and helped them?",
  "What if the final boss just wanted to be friends?",
  "What if your world had two suns instead of one? ☀️☀️",
]);

// ── Bible-teacher variant (matches the persona split in game-suggestions.ts) ─
// Imagination sparks framed around the game's scripture setting, not generic
// fantasy — same open-ended, story/theme spirit as the kid pool above.
export const BIBLE_IMAGINATION_HINTS: readonly string[] = Object.freeze([
  "What if you could see the story from a different character's point of view?",
  "What if the game showed how the animals felt on Noah's ark? 🦓",
  "What if there was a bonus level celebrating when the story's heroes won?",
  "What if your game had a song verse play when the child wins?",
  "What if the setting changed from day to night as the story goes on?",
  "What if a kind stranger appeared partway through to help?",
  "What if the game let the child choose which brave choice to make next?",
  "What if there was a secret blessing hidden somewhere in the game?",
  "What if the game showed the story's setting changing with the seasons?",
  "What if you added a gentle narrator who explains what's happening?",
  "What if the child could collect a small token for each act of kindness in the story?",
  "What if the ending showed everyone celebrating together?",
]);

/** Pick `count` distinct random hints from `pool`. Same injectable-`rand`
 *  shape as game-suggestions.ts's pickSuggestions, for deterministic tests. */
export function pickImaginationHints(
  count = 1,
  rand: () => number = Math.random,
  pool: readonly string[] = IMAGINATION_HINTS,
): string[] {
  const remaining = [...pool];
  const picks: string[] = [];
  while (picks.length < count && remaining.length > 0) {
    picks.push(remaining.splice(Math.floor(rand() * remaining.length), 1)[0]!);
  }
  return picks;
}
