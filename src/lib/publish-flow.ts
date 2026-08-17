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
  /** Edit-a-launched-game (PRD-STUDIO-CHAT-EDIT rev 2026-07-24): the chat is
   *  already bound to a published slug, so "which game?" is answered — go
   *  straight to the confirm step as an update. */
  hasPresetTarget?: boolean;
}): PublishStep {
  if (args.current !== "loading" && args.current !== "signin") return args.current;
  if (args.hasPresetTarget) return "name";
  return args.gameCount > 0 ? "choose" : "name";
}

/** The name-availability answer the sheet is holding, as far as this decision
 *  cares. `checking`/`unknown` deliberately do NOT block — an unanswered check
 *  must never claim a name is gone, and publish re-validates server-side. */
export type NameCheckState = "idle" | "checking" | "free" | "taken" | "mine" | "copyright" | "unknown";

export interface PublishBlockInput {
  /** The display name typed on the name step. */
  name: string;
  /** The chosen category, or null if the kid hasn't picked one. */
  category: string | null;
  check: NameCheckState;
  /** "Use a different web address" is ticked. */
  useCustomSlug?: boolean;
  /** What was typed into that address field (raw, pre-slug). */
  customSlug?: string;
  /** Bible-teacher surface fixes the category — no picker, so none required. */
  bibleGame?: boolean;
  /** Republishing an existing game: name and category already belong to it. */
  isUpdate?: boolean;
}

/**
 * Why the "Next" button can't be pressed yet — or null when it can.
 *
 * Owner report 2026-08-17 ("use a different url in the publish don't work"):
 * the button's `disabled` was computed inline from `!slug || !category || …`
 * and nothing on screen said which of those was the problem. Ticking "Use a
 * different web address" swapped the slug source to an empty field and killed
 * the button on the spot, with a full name field sitting right above it — so
 * it read as the checkbox being broken.
 *
 * One function so the disabled state and the sentence under it cannot drift:
 * the component disables on `!== null` and prints the string. Kid-facing copy
 * (CLAUDE.md §5 — a failure says what to do next), so it is written to be read
 * by an eight-year-old, not to be precise.
 */
export function publishBlockReason(input: PublishBlockInput): string | null {
  const { check, isUpdate = false, bibleGame = false } = input;

  // A name that belongs to someone else — or to a film studio — blocks
  // regardless of everything below; it's the only thing the kid must change.
  if (check === "taken") return "Someone already has that name — try another name!";
  if (check === "copyright") return "That name belongs to a big company — pick your own and it'll be cooler!";

  // An update reuses the existing game's name, address and category.
  if (isUpdate) return null;

  if (input.useCustomSlug) {
    const typed = (input.customSlug ?? "").trim();
    if (!typed) return "Type the web address you want, like my-cool-game";
    // Two usable characters minimum — nameToSlug() returns "" below that, and
    // "" quietly became a dead button plus a hint reading ".ariantra.com".
    if (slugify(typed).length < 2) return "That address needs at least 2 letters or numbers, like my-cool-game";
  } else if (!slugify(input.name)) {
    return "Give your game a name first!";
  }

  if (!bibleGame && !input.category) return "Pick what kind of game it is";

  return null;
}

/** The slug rule, duplicated as a length check only. Kept local rather than
 *  importing lib/arcade so this module stays pure/dependency-free; arcade.ts's
 *  nameToSlug remains the one that actually produces the address. */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}
