// BUG-FIX-LOG 2026-07-28 (kid report, turtle memory game): the next-ask
// fallback used to serve game-suggestions.ts's brand-new-game STARTERS
// ("Make me a flying game with monkeys 🐵") as "what to try next" on a game
// the kid was already building. This pool replaces them with suggestions that
// change THE CURRENT game.
import { describe, expect, it } from "vitest";
import { GAME_SUGGESTIONS, BIBLE_GAME_SUGGESTIONS } from "./game-suggestions";
import { BIBLE_TWEAK_SUGGESTIONS, TWEAK_SUGGESTIONS, pickTweakSuggestions } from "./tweak-suggestions";

describe("TWEAK_SUGGESTIONS pool", () => {
  it("has a reasonable number of entries (variety floor)", () => {
    expect(TWEAK_SUGGESTIONS.length).toBeGreaterThanOrEqual(20);
  });

  it("has no duplicates and no empty entries", () => {
    expect(new Set(TWEAK_SUGGESTIONS).size).toBe(TWEAK_SUGGESTIONS.length);
    for (const s of TWEAK_SUGGESTIONS) expect(s.trim().length).toBeGreaterThan(0);
  });

  // THE REGRESSION: a "Make me a … game …" entry here would recreate the exact
  // reported bug — an unrelated new-game starter shown as a next step, which
  // ABANDONS the kid's current game when tapped.
  it("never asks for a NEW game — every entry changes the current one", () => {
    for (const s of TWEAK_SUGGESTIONS) {
      expect(s, `"${s}" reads as a brand-new-game starter`).not.toMatch(/^Make me a /i);
    }
  });

  it("shares nothing with the brand-new-game starter pool", () => {
    const starters = new Set(GAME_SUGGESTIONS);
    expect(TWEAK_SUGGESTIONS.some((s) => starters.has(s))).toBe(false);
  });
});

describe("BIBLE_TWEAK_SUGGESTIONS pool", () => {
  it("has entries, no duplicates, none empty", () => {
    expect(BIBLE_TWEAK_SUGGESTIONS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(BIBLE_TWEAK_SUGGESTIONS).size).toBe(BIBLE_TWEAK_SUGGESTIONS.length);
    for (const s of BIBLE_TWEAK_SUGGESTIONS) expect(s.trim().length).toBeGreaterThan(0);
  });

  it("never asks for a NEW game either", () => {
    for (const s of BIBLE_TWEAK_SUGGESTIONS) expect(s).not.toMatch(/^Make me a /i);
  });

  it("shares nothing with the bible starter pool or the kid tweak pool", () => {
    const starters = new Set(BIBLE_GAME_SUGGESTIONS);
    expect(BIBLE_TWEAK_SUGGESTIONS.some((s) => starters.has(s))).toBe(false);
    const kid = new Set(TWEAK_SUGGESTIONS);
    expect(BIBLE_TWEAK_SUGGESTIONS.some((s) => kid.has(s))).toBe(false);
  });
});

describe("pickTweakSuggestions", () => {
  it("returns 2 distinct suggestions by default", () => {
    const picks = pickTweakSuggestions();
    expect(picks).toHaveLength(2);
    expect(new Set(picks).size).toBe(2);
    for (const p of picks) expect(TWEAK_SUGGESTIONS).toContain(p);
  });

  it("is driven by the injected rand", () => {
    expect(pickTweakSuggestions(1, () => 0)).not.toEqual(pickTweakSuggestions(1, () => 0.999999));
  });

  it("same rand sequence ⇒ same picks (deterministic)", () => {
    const seq = () => {
      let i = 0;
      const vals = [0.2, 0.7, 0.4];
      return () => vals[i++ % vals.length]!;
    };
    expect(pickTweakSuggestions(3, seq())).toEqual(pickTweakSuggestions(3, seq()));
  });

  it("never returns more than the pool holds", () => {
    const picks = pickTweakSuggestions(TWEAK_SUGGESTIONS.length + 5, () => 0.5);
    expect(picks.length).toBe(TWEAK_SUGGESTIONS.length);
  });
});
