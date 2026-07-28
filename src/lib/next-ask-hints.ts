// Fallback next-ask chip pool (2026-07-28, PRD Game/docs/2026-07-27_PRD_KidHintsAndNextBestAsk.md).
// The PRIMARY source of the 3 "what to try next" chips is the model itself
// (see next-ask-sentinel.ts) — it already knows exactly what game it just
// built, so its suggestions are contextual in a way a static pool can't be.
// This module is the SAFETY NET: used on the very first turn (no game built
// yet), on edit/patch turns (which never carry the model instruction — see
// next-ask-sentinel.ts's header comment), and whenever the model's sentinel
// line is missing or fails validation, so a kid is never left with zero
// suggestions.

import { suggestionsFor } from "./game-suggestions";
import { BIBLE_IMAGINATION_HINTS, IMAGINATION_HINTS, pickImaginationHints } from "./imagination-hints";

/** 2 concrete/mechanic chips + 1 imagination-spark chip — the same 2+1 mix
 *  guidance given to the model in next-ask-sentinel.ts's prompt section, so
 *  the fallback and the model-generated path feel like the same feature. */
export function buildFallbackNextAskHints(
  persona: "bible-teacher" | undefined,
  rand: () => number = Math.random,
): string[] {
  const pool = persona === "bible-teacher" ? BIBLE_IMAGINATION_HINTS : IMAGINATION_HINTS;
  return [...suggestionsFor(persona, 2, rand), ...pickImaginationHints(1, rand, pool)];
}

/** Server-side kill switch (rollout: default OFF until UAT'd with real kids).
 *  Gates BOTH the model prompt section (gemini.ts) and whether route.ts
 *  attaches any nextAskHints at all — the client never needs its own copy of
 *  this flag, since it only ever sees the field when the server chose to send
 *  it (avoids the NEXT_PUBLIC_ client-inlining pitfall entirely). */
export function kidHintsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PUBLIC_ENABLE_KID_HINTS === "1";
}
