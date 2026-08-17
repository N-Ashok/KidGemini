// Pins the kid-facing filter for Gemini thought summaries (2026-07-11):
// thoughts are MODEL OUTPUT shown to a child during the thinking phase, so
// only clean prose passes — anything code-like, markdown-heavy, or degenerate
// is dropped (null) and the UI keeps its previous line. Fail closed.
import { describe, expect, it } from "vitest";
import { kidThoughtLine, KID_THOUGHT_MAX_CHARS } from "./kid-thought";

describe("kidThoughtLine", () => {
  it("passes plain planning prose through, trimmed", () => {
    expect(kidThoughtLine("  I'll set up the spaceship and laser controls first. ")).toBe(
      "I'll set up the spaceship and laser controls first.",
    );
  });

  it("strips markdown headings/emphasis and collapses whitespace", () => {
    expect(kidThoughtLine("**Planning the game**\n\nFirst I will design   the maze layout.")).toBe(
      "Planning the game First I will design the maze layout.",
    );
  });

  it("keeps only the first sentences up to the cap, ending on a word", () => {
    const long = `${"Designing the level layout with lots of fun obstacles. ".repeat(10)}`;
    const line = kidThoughtLine(long)!;
    expect(line.length).toBeLessThanOrEqual(KID_THOUGHT_MAX_CHARS);
    expect(line).toMatch(/…$|\.$/);
  });

  it("rejects code-like content (never show a child raw code or HTML)", () => {
    expect(kidThoughtLine("const player = { x: 0 };")).toBeNull();
    expect(kidThoughtLine("<canvas id='game'>")).toBeNull();
    expect(kidThoughtLine("use requestAnimationFrame(); then draw")).toBeNull();
    expect(kidThoughtLine("```js\nlet a = 1\n```")).toBeNull();
  });

  it("rejects empty, whitespace, and too-short fragments", () => {
    expect(kidThoughtLine("")).toBeNull();
    expect(kidThoughtLine("   \n ")).toBeNull();
    expect(kidThoughtLine("Ok.")).toBeNull();
  });

  // BUG-FIX-LOG 2026-08-01: a single code-like sentence used to sink the
  // WHOLE thought, even when a clean, kid-safe sentence sat right next to
  // it — exactly what edit-turn thinking tends to produce (a code/function
  // reference plus a plain-English planning line). Each sentence is now
  // judged on its own; the first clean one wins.
  it("salvages a clean sentence sitting next to a code-like one, instead of rejecting the whole thought", () => {
    expect(kidThoughtLine("I'll tweak update() for gravity. Time to make it feel bouncy!")).toBe(
      "Time to make it feel bouncy!",
    );
    expect(kidThoughtLine("Let's use const player = {}. Now adding the jump animation.")).toBe(
      "Now adding the jump animation.",
    );
  });

  it("still rejects a thought where every sentence is code-like", () => {
    expect(kidThoughtLine("const player = { x: 0 }. let jump = true.")).toBeNull();
  });
});
