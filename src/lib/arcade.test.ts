import { describe, it, expect } from "vitest";
import { nameToSlug } from "./arcade";

/** "Put it in the Arcade": the kid types a game NAME; we derive the subdomain. */
describe("nameToSlug", () => {
  it("lowercases, hyphenates, strips punctuation/emoji", () => {
    expect(nameToSlug("Dragon Flyer!")).toBe("dragon-flyer");
    expect(nameToSlug("  Super   Star 🌟 Race  ")).toBe("super-star-race");
    expect(nameToSlug("Agilan's Chess")).toBe("agilans-chess");
  });

  it("keeps digits, collapses repeats, trims hyphens", () => {
    expect(nameToSlug("Space--Fight  2")).toBe("space-fight-2");
    expect(nameToSlug("---wow---")).toBe("wow");
  });

  it("caps at 40 chars and returns '' when nothing usable remains", () => {
    expect(nameToSlug("x".repeat(60)).length).toBeLessThanOrEqual(40);
    expect(nameToSlug("🎮🎮🎮")).toBe("");
    expect(nameToSlug("")).toBe("");
  });
});
