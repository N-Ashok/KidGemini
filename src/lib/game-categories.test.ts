// Live-category plumbing (owner ask 2026-07-26: categories are now
// admin-extendable platform-side; Ari fetches the live list and falls back
// to the baked base list offline).
import { describe, it, expect } from "vitest";
import { GAME_CATEGORIES, sanitizeCategories } from "./game-categories";

describe("sanitizeCategories", () => {
  it("GC.1 accepts a clean server list", () => {
    expect(sanitizeCategories(["Puzzle", "Sports", "Other"])).toEqual(["Puzzle", "Sports", "Other"]);
  });

  it("GC.2 rejects junk wholesale (caller keeps the baked fallback)", () => {
    expect(sanitizeCategories(undefined)).toBeNull();
    expect(sanitizeCategories("Puzzle")).toBeNull();
    expect(sanitizeCategories([])).toBeNull();
    expect(sanitizeCategories([1, 2])).toBeNull();
  });

  it("GC.3 drops non-string / oversized entries but keeps the good ones", () => {
    expect(sanitizeCategories(["Puzzle", 42, "X".repeat(50), "Sports"])).toEqual(["Puzzle", "Sports"]);
  });

  it("GC.4 caps a runaway list at 40 entries", () => {
    const big = Array.from({ length: 60 }, (_, i) => `C${i}`);
    expect(sanitizeCategories(big)!.length).toBe(40);
  });

  it("GC.5 the baked fallback still ends in Other (kid picker default order)", () => {
    expect(GAME_CATEGORIES.at(-1)).toBe("Other");
  });
});
