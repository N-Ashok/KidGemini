import { describe, expect, it } from "vitest";
import { IMAGINATION_HINTS, BIBLE_IMAGINATION_HINTS } from "./imagination-hints";
import { BIBLE_TWEAK_SUGGESTIONS, TWEAK_SUGGESTIONS } from "./tweak-suggestions";
import { buildFallbackNextAskHints, kidHintsEnabled } from "./next-ask-hints";

describe("buildFallbackNextAskHints", () => {
  it("returns exactly 3 unique strings for the kid persona", () => {
    const hints = buildFallbackNextAskHints(undefined, () => 0.5);
    expect(hints).toHaveLength(3);
    expect(new Set(hints).size).toBe(3);
  });

  it("2 change the CURRENT game, 1 is an imagination spark (kid)", () => {
    const hints = buildFallbackNextAskHints(undefined, () => 0.5);
    const tweakCount = hints.filter((h) => TWEAK_SUGGESTIONS.includes(h)).length;
    const imaginationCount = hints.filter((h) => IMAGINATION_HINTS.includes(h)).length;
    expect(tweakCount).toBe(2);
    expect(imaginationCount).toBe(1);
  });

  // THE REPORTED BUG (kid report 2026-07-28, turtle memory game): the fallback
  // used to hand back brand-new-game starters — "Make me a flying game with
  // monkeys 🐵" under a turtle memory game. Unrelated to what's on screen, and
  // tapping one throws away the game the kid is building.
  it("never suggests starting a BRAND-NEW game", () => {
    for (const rand of [() => 0, () => 0.25, () => 0.5, () => 0.75, () => 0.999999]) {
      for (const h of buildFallbackNextAskHints(undefined, rand)) {
        expect(h, `"${h}" would abandon the kid's current game`).not.toMatch(/^Make me a /i);
      }
      for (const h of buildFallbackNextAskHints("bible-teacher", rand)) {
        expect(h).not.toMatch(/^Make me a /i);
      }
    }
  });

  it("uses the bible-teacher pools for that persona", () => {
    const hints = buildFallbackNextAskHints("bible-teacher", () => 0.5);
    const tweakCount = hints.filter((h) => BIBLE_TWEAK_SUGGESTIONS.includes(h)).length;
    const imaginationCount = hints.filter((h) => BIBLE_IMAGINATION_HINTS.includes(h)).length;
    expect(tweakCount).toBe(2);
    expect(imaginationCount).toBe(1);
  });

  it("same rand sequence ⇒ same hints (deterministic)", () => {
    const seq = () => {
      let i = 0;
      const vals = [0.1, 0.5, 0.9, 0.3];
      return () => vals[i++ % vals.length]!;
    };
    expect(buildFallbackNextAskHints(undefined, seq())).toEqual(buildFallbackNextAskHints(undefined, seq()));
  });
});

describe("kidHintsEnabled", () => {
  it("is true only when the flag is exactly '1'", () => {
    expect(kidHintsEnabled({ NEXT_PUBLIC_ENABLE_KID_HINTS: "1" })).toBe(true);
  });

  it("is false when unset, '0', or any other value", () => {
    expect(kidHintsEnabled({})).toBe(false);
    expect(kidHintsEnabled({ NEXT_PUBLIC_ENABLE_KID_HINTS: "0" })).toBe(false);
    expect(kidHintsEnabled({ NEXT_PUBLIC_ENABLE_KID_HINTS: "true" })).toBe(false);
  });
});
