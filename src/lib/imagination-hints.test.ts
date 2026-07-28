// Tests for the imagination-spark pool (mirrors game-suggestions.test.ts).
import { describe, expect, it } from "vitest";
import { BIBLE_IMAGINATION_HINTS, IMAGINATION_HINTS, pickImaginationHints } from "./imagination-hints";

describe("IMAGINATION_HINTS pool", () => {
  it("has at least 20 entries (scale floor per the PRD)", () => {
    expect(IMAGINATION_HINTS.length).toBeGreaterThanOrEqual(20);
  });

  it("has no duplicates and no empty entries", () => {
    expect(new Set(IMAGINATION_HINTS).size).toBe(IMAGINATION_HINTS.length);
    for (const h of IMAGINATION_HINTS) expect(h.trim().length).toBeGreaterThan(0);
  });

  it("every hint is open-ended (asks a question, not a mechanical add)", () => {
    for (const h of IMAGINATION_HINTS) expect(h).toMatch(/\?/);
  });
});

describe("BIBLE_IMAGINATION_HINTS pool", () => {
  it("has at least 10 entries", () => {
    expect(BIBLE_IMAGINATION_HINTS.length).toBeGreaterThanOrEqual(10);
  });

  it("has no duplicates and no empty entries", () => {
    expect(new Set(BIBLE_IMAGINATION_HINTS).size).toBe(BIBLE_IMAGINATION_HINTS.length);
    for (const h of BIBLE_IMAGINATION_HINTS) expect(h.trim().length).toBeGreaterThan(0);
  });

  it("does not reuse the kid pool", () => {
    const kid = new Set(IMAGINATION_HINTS);
    expect(BIBLE_IMAGINATION_HINTS.some((h) => kid.has(h))).toBe(false);
  });
});

describe("pickImaginationHints", () => {
  it("returns 1 hint from the pool by default", () => {
    const picks = pickImaginationHints();
    expect(picks).toHaveLength(1);
    expect(IMAGINATION_HINTS).toContain(picks[0]);
  });

  it("returns distinct hints when count > 1", () => {
    const picks = pickImaginationHints(3, () => 0.5);
    expect(new Set(picks).size).toBe(3);
  });

  it("is driven by the injected rand — different rand, different picks", () => {
    const a = pickImaginationHints(1, () => 0);
    const b = pickImaginationHints(1, () => 0.999999);
    expect(a).not.toEqual(b);
  });

  it("same rand sequence ⇒ same picks (deterministic)", () => {
    const seq = () => {
      let i = 0;
      const vals = [0.1, 0.5, 0.9];
      return () => vals[i++ % vals.length]!;
    };
    expect(pickImaginationHints(3, seq())).toEqual(pickImaginationHints(3, seq()));
  });

  it("never returns more than the pool holds", () => {
    const picks = pickImaginationHints(IMAGINATION_HINTS.length + 5, () => 0.5);
    expect(picks.length).toBe(IMAGINATION_HINTS.length);
    expect(new Set(picks).size).toBe(picks.length);
  });
});
