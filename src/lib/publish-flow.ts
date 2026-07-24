// Step sequencing for the "🚀 Put it in the Arcade" sheet (PublishToArcade.tsx).
// Pure — the component renders states, this decides which one.
//
// BUG-FIX-LOG 2026-07-24: the sheet opened on `name` and then corrected itself
// once /api/arcade/publish `{list:true}` answered, so a kid with existing games
// watched "Name your game!" → "What are we doing?" → (after picking brand-new)
// "Name your game!" again. Showing a step you might have to take away reads as
// a broken, looping modal. Now it opens on `loading` and commits once.

export type PublishStep =
  | "loading"
  | "signin"
  | "choose"
  | "pick"
  | "name"
  | "pin"
  | "publishing"
  | "done";

/** Never `name`/`choose`: at open time we don't yet know which is right. */
export const INITIAL_PUBLISH_STEP: PublishStep = "loading";

/** Where to go when the kid's game list resolves. Only the two steps that are
 *  waiting for that answer (`loading`, and `signin` after a sign-in round trip)
 *  move — anything else is a step the kid is actively working on, and a late
 *  (or retried) list response must never yank them out of it. */
export function stepAfterGamesLoad(args: {
  current: PublishStep;
  /** Games already in the Arcade. A failed load counts as 0 — the name step
   *  carries its own "couldn't check your games" retry. */
  gameCount: number;
}): PublishStep {
  if (args.current !== "loading" && args.current !== "signin") return args.current;
  return args.gameCount > 0 ? "choose" : "name";
}
