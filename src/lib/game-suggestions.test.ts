// Tests for the starter-chip suggestion pool (user request 2026-07-08:
// "everytime it loads different 4 game suggestion should be there …
// a list of 500 game suggestions … use random four everytime").
import { describe, expect, it } from "vitest";
import {
  BIBLE_GAME_SUGGESTIONS,
  BIBLE_MECHANICS,
  GAME_SUGGESTIONS,
  MECHANICS,
  pickSuggestions,
  suggestionsFor,
} from "./game-suggestions";

describe("GAME_SUGGESTIONS pool", () => {
  it("has at least 500 suggestions", () => {
    expect(GAME_SUGGESTIONS.length).toBeGreaterThanOrEqual(500);
  });

  it("has no duplicates and no empty entries", () => {
    expect(new Set(GAME_SUGGESTIONS).size).toBe(GAME_SUGGESTIONS.length);
    for (const s of GAME_SUGGESTIONS) expect(s.trim().length).toBeGreaterThan(0);
  });

  it("every suggestion asks for a game (kid taps it as a prompt)", () => {
    for (const s of GAME_SUGGESTIONS) expect(s).toMatch(/^Make me a .+ game/);
  });
});

describe("pickSuggestions", () => {
  it("returns 4 distinct suggestions from the pool by default", () => {
    const picks = pickSuggestions();
    expect(picks).toHaveLength(4);
    expect(new Set(picks).size).toBe(4);
    for (const p of picks) expect(GAME_SUGGESTIONS).toContain(p);
  });

  it("is driven by the injected rand — different rand, different picks", () => {
    const a = pickSuggestions(4, () => 0);
    const b = pickSuggestions(4, () => 0.999999);
    expect(a).not.toEqual(b);
  });

  it("same rand sequence ⇒ same picks (deterministic, so the UI is testable)", () => {
    const seq = () => {
      let i = 0;
      const vals = [0.1, 0.5, 0.9, 0.3];
      return () => vals[i++ % vals.length]!;
    };
    expect(pickSuggestions(4, seq())).toEqual(pickSuggestions(4, seq()));
  });

  it("the 4 picks are 4 DIFFERENT game types (no 'three jump-and-runs' loads)", () => {
    // Any rand must yield mechanic-diverse picks; probe several.
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const picks = pickSuggestions(4, () => r);
      const types = picks.map((p) => MECHANICS.find((m) => p.includes(m)));
      expect(new Set(types).size).toBe(4);
    }
  });

  it("never returns more than the pool holds (count > pool is safe)", () => {
    const picks = pickSuggestions(GAME_SUGGESTIONS.length + 10, () => 0.5);
    expect(picks.length).toBe(GAME_SUGGESTIONS.length);
    expect(new Set(picks).size).toBe(picks.length);
  });
});

// ── Bible-teacher pool (owner request 2026-07-24) ────────────────────────────
// Same shape and same 4-of-500 behaviour as the kid pool, but every starter is
// scripture-oriented: the teacher surface showed kid themes (dinosaurs, aliens,
// unicorns), which is the wrong prompt for someone building a Sunday-school
// lesson.
describe("BIBLE_GAME_SUGGESTIONS pool", () => {
  it("has at least 500 suggestions, like the kid pool", () => {
    expect(BIBLE_GAME_SUGGESTIONS.length).toBeGreaterThanOrEqual(500);
  });

  it("has no duplicates and no empty entries", () => {
    expect(new Set(BIBLE_GAME_SUGGESTIONS).size).toBe(BIBLE_GAME_SUGGESTIONS.length);
    for (const s of BIBLE_GAME_SUGGESTIONS) expect(s.trim().length).toBeGreaterThan(0);
  });

  it("every suggestion asks for a game", () => {
    for (const s of BIBLE_GAME_SUGGESTIONS) expect(s).toMatch(/^Make me a .+ game/);
  });

  it("carries NO kid-surface themes — that mismatch is the reported bug", () => {
    const offSurface = ["dinosaur", "alien", "unicorn", "robot", "ninja", "zombie", "pizza", "superhero"];
    for (const s of BIBLE_GAME_SUGGESTIONS) {
      for (const word of offSurface) {
        expect(s.toLowerCase(), `"${s}" is not a Bible theme`).not.toContain(word);
      }
    }
  });

  it("uses no combat/shooter mechanic — wrong register for scripture", () => {
    for (const m of BIBLE_MECHANICS) {
      expect(m).not.toMatch(/shoot|fight|battle|war/i);
    }
    for (const s of BIBLE_GAME_SUGGESTIONS) expect(s).not.toMatch(/shooter/i);
  });

  it("does not reuse the kid pool", () => {
    const kid = new Set(GAME_SUGGESTIONS);
    expect(BIBLE_GAME_SUGGESTIONS.some((s) => kid.has(s))).toBe(false);
  });
});

describe("suggestionsFor — the surface picks the pool", () => {
  it("gives a bible-teacher 4 scripture starters", () => {
    const picks = suggestionsFor("bible-teacher");
    expect(picks).toHaveLength(4);
    for (const p of picks) expect(BIBLE_GAME_SUGGESTIONS).toContain(p);
  });

  it("gives everyone else the kid pool (unchanged default)", () => {
    for (const p of suggestionsFor(undefined)) expect(GAME_SUGGESTIONS).toContain(p);
  });

  it("round-robins bible mechanics so one load never repeats a game type", () => {
    const picks = suggestionsFor("bible-teacher", 4, () => 0.5);
    const kinds = picks.map((p) => BIBLE_MECHANICS.find((m) => p.includes(m)));
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
