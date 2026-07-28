import { describe, expect, it } from "vitest";
import { GAME_SUGGESTIONS, BIBLE_GAME_SUGGESTIONS } from "./game-suggestions";
import { IMAGINATION_HINTS, BIBLE_IMAGINATION_HINTS } from "./imagination-hints";
import { buildFallbackNextAskHints, kidHintsEnabled } from "./next-ask-hints";

describe("buildFallbackNextAskHints", () => {
  it("returns exactly 3 unique strings for the kid persona", () => {
    const hints = buildFallbackNextAskHints(undefined, () => 0.5);
    expect(hints).toHaveLength(3);
    expect(new Set(hints).size).toBe(3);
  });

  it("2 are from the mechanic pool, 1 is from the imagination pool (kid)", () => {
    const hints = buildFallbackNextAskHints(undefined, () => 0.5);
    const mechanicCount = hints.filter((h) => GAME_SUGGESTIONS.includes(h)).length;
    const imaginationCount = hints.filter((h) => IMAGINATION_HINTS.includes(h)).length;
    expect(mechanicCount).toBe(2);
    expect(imaginationCount).toBe(1);
  });

  it("uses the bible-teacher pools for that persona", () => {
    const hints = buildFallbackNextAskHints("bible-teacher", () => 0.5);
    const mechanicCount = hints.filter((h) => BIBLE_GAME_SUGGESTIONS.includes(h)).length;
    const imaginationCount = hints.filter((h) => BIBLE_IMAGINATION_HINTS.includes(h)).length;
    expect(mechanicCount).toBe(2);
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
