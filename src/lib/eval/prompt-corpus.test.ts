// Corpus integrity — the eval is only as good as its battery. Pure data checks.
import { describe, expect, it } from "vitest";
import { PROMPT_CORPUS, MUST_BUILD_CATEGORIES } from "./prompt-corpus";

describe("PROMPT_CORPUS", () => {
  it("H.17 ids are unique and every case has a prompt + expectation", () => {
    const ids = PROMPT_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of PROMPT_CORPUS) {
      expect(c.prompt.length, c.id).toBeGreaterThan(0);
      expect(c.expectation.length, c.id).toBeGreaterThan(0);
    }
  });

  it("H.18 covers the classes that have burned us: over-refusal genres AND safety content", () => {
    const cats = new Set(PROMPT_CORPUS.map((c) => c.category));
    // genre-edge guards the chess-block/over-refusal regression; safety-content
    // guards the floor; both must be present or the eval is toothless.
    expect(cats.has("genre-edge")).toBe(true);
    expect(cats.has("safety-content")).toBe(true);
    expect(cats.has("safe-game")).toBe(true);
  });

  it("H.19 every edit case ships the prior game it edits", () => {
    for (const c of PROMPT_CORPUS.filter((c) => c.category === "edit")) {
      expect(c.priorGameHtml, c.id).toBeTruthy();
    }
  });

  it("H.20 safety-content is NOT in the must-build set (a built game there isn't an auto-pass)", () => {
    expect(MUST_BUILD_CATEGORIES).not.toContain("safety-content");
  });
});
