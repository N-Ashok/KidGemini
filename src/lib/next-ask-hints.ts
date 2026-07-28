// Fallback next-ask chip pool (2026-07-28, PRD Game/docs/2026-07-27_PRD_KidHintsAndNextBestAsk.md).
// The PRIMARY source of the 3 "what to try next" chips is the model itself
// (see next-ask-sentinel.ts) — it already knows exactly what game it just
// built, so its suggestions are contextual in a way a static pool can't be.
// This module is the SAFETY NET: used on the very first turn (no game built
// yet), on edit/patch turns (which never carry the model instruction — see
// next-ask-sentinel.ts's header comment), and whenever the model's sentinel
// line is missing or fails validation, so a kid is never left with zero
// suggestions.

import { BIBLE_IMAGINATION_HINTS, IMAGINATION_HINTS, pickImaginationHints } from "./imagination-hints";
import { BIBLE_TWEAK_SUGGESTIONS, TWEAK_SUGGESTIONS, pickTweakSuggestions } from "./tweak-suggestions";

/**
 * 2 concrete "change THIS game" chips + 1 imagination-spark chip — the same
 * 2+1 mix guidance given to the model in next-ask-sentinel.ts's prompt
 * section, so the fallback and the model-generated path feel like one feature.
 *
 * The concrete two come from tweak-suggestions.ts, NOT game-suggestions.ts.
 * BUG-FIX-LOG 2026-07-28 (kid report, turtle memory game): this originally
 * called suggestionsFor(), whose entries are all "Make me a {mechanic} game
 * {theme}" — brand-new-game STARTERS meant for the blank first screen. Shown
 * as "what to try next" they read as completely unrelated to the game on
 * screen, and tapping one abandons it to build something else entirely.
 *
 * Only ever called when a game actually exists (route.ts gates on
 * deliverableHtml), so "change this game" phrasing is always the right register.
 */
export function buildFallbackNextAskHints(
  persona: "bible-teacher" | undefined,
  rand: () => number = Math.random,
): string[] {
  const bible = persona === "bible-teacher";
  return [
    ...pickTweakSuggestions(2, rand, bible ? BIBLE_TWEAK_SUGGESTIONS : TWEAK_SUGGESTIONS),
    ...pickImaginationHints(1, rand, bible ? BIBLE_IMAGINATION_HINTS : IMAGINATION_HINTS),
  ];
}

/** Server-side kill switch (rollout: default OFF until UAT'd with real kids).
 *  Gates BOTH the model prompt section (gemini.ts) and whether route.ts
 *  attaches any nextAskHints at all — the client never needs its own copy of
 *  this flag, since it only ever sees the field when the server chose to send
 *  it (avoids the NEXT_PUBLIC_ client-inlining pitfall entirely). */
export function kidHintsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PUBLIC_ENABLE_KID_HINTS === "1";
}
