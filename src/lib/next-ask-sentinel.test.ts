import { describe, expect, it } from "vitest";
import { NEXT_ASKS_PREFIX, hidePartialNextAskLine, parseNextAskLine } from "./next-ask-sentinel";

const VALID_LINE = `${NEXT_ASKS_PREFIX} Add a power-up | Make the dragon faster | What if it happened underwater?`;

describe("parseNextAskLine", () => {
  it("parses a valid trailing sentinel line into 3 ideas", () => {
    const result = parseNextAskLine(`Here's your game! 🎮\n\n${VALID_LINE}`);
    expect(result).not.toBeNull();
    expect(result!.ideas).toEqual([
      "Add a power-up",
      "Make the dragon faster",
      "What if it happened underwater?",
    ]);
  });

  it("strips the sentinel line from cleanedText", () => {
    const result = parseNextAskLine(`Here's your game! 🎮\n\n${VALID_LINE}`);
    expect(result!.cleanedText).toBe("Here's your game! 🎮");
    expect(result!.cleanedText).not.toContain(NEXT_ASKS_PREFIX);
  });

  it("works when the sentinel is the ONLY line", () => {
    const result = parseNextAskLine(VALID_LINE);
    expect(result!.ideas).toHaveLength(3);
    expect(result!.cleanedText).toBe("");
  });

  it("returns null when there's no sentinel at all", () => {
    expect(parseNextAskLine("Here's your game! 🎮")).toBeNull();
  });

  it("returns null when the sentinel isn't on the TRAILING line", () => {
    const result = parseNextAskLine(`${VALID_LINE}\n\nOne more thing!`);
    expect(result).toBeNull();
  });

  it("returns null on the wrong idea count", () => {
    expect(parseNextAskLine(`${NEXT_ASKS_PREFIX} only one idea`)).toBeNull();
    expect(parseNextAskLine(`${NEXT_ASKS_PREFIX} a | b | c | d`)).toBeNull();
  });

  it("returns null when any idea is empty", () => {
    expect(parseNextAskLine(`${NEXT_ASKS_PREFIX} a | | c`)).toBeNull();
  });

  it("returns null when any idea is oversized", () => {
    const long = "x".repeat(81);
    expect(parseNextAskLine(`${NEXT_ASKS_PREFIX} a | b | ${long}`)).toBeNull();
  });

  it("returns null on HTML/code-like content in an idea (defensive parsing)", () => {
    expect(parseNextAskLine(`${NEXT_ASKS_PREFIX} a | <script>bad</script> | c`)).toBeNull();
    expect(parseNextAskLine(`${NEXT_ASKS_PREFIX} a | b | \`\`\`js code\`\`\``)).toBeNull();
  });

  it("returns null (never throws) on empty/whitespace-only input", () => {
    expect(parseNextAskLine("")).toBeNull();
    expect(parseNextAskLine("   \n  \n ")).toBeNull();
  });

  it("trims whitespace around each idea", () => {
    const result = parseNextAskLine(`${NEXT_ASKS_PREFIX}   a   |  b  |  c  `);
    expect(result!.ideas).toEqual(["a", "b", "c"]);
  });
});

// Regression coverage for a bug caught in live manual testing: the raw
// NEXT_ASKS line was streaming into the chat bubble token-by-token, visible
// to the kid, before route.ts's final cleanup ever ran on the `done` event.
describe("hidePartialNextAskLine", () => {
  it("hides the line as it grows through every prefix of the sentinel token", () => {
    const prefixes = ["N", "NE", "NEX", "NEXT", "NEXT_", "NEXT_A", "NEXT_AS", "NEXT_ASK", "NEXT_ASKS", "NEXT_ASKS:"];
    for (const p of prefixes) {
      expect(hidePartialNextAskLine(`Here's your game! 🎮\n\n${p}`)).toBe("Here's your game! 🎮");
    }
  });

  it("keeps hiding once the line has grown past the prefix into idea text", () => {
    const partial = `Here's your game! 🎮\n\nNEXT_ASKS: Add a power-up | Make the drag`;
    expect(hidePartialNextAskLine(partial)).toBe("Here's your game! 🎮");
  });

  it("hides a complete NEXT_ASKS line too (still streaming, done event hasn't fired yet)", () => {
    const partial = `Here's your game! 🎮\n\n${NEXT_ASKS_PREFIX} a | b | c`;
    expect(hidePartialNextAskLine(partial)).toBe("Here's your game! 🎮");
  });

  it("is a no-op on ordinary text, even text starting with 'N'", () => {
    expect(hidePartialNextAskLine("No problem, adding that now!")).toBe("No problem, adding that now!");
    expect(hidePartialNextAskLine("Here's your game! 🎮")).toBe("Here's your game! 🎮");
  });

  it("returns empty string when the ENTIRE partial is just the sentinel prefix", () => {
    expect(hidePartialNextAskLine("NEXT_A")).toBe("");
  });

  it("is a no-op on empty input", () => {
    expect(hidePartialNextAskLine("")).toBe("");
  });

  // Exact accumulated-text snapshot captured from a live manual run against
  // the real Gemini API (2026-07-28) — pins the fix to the actual bug found.
  it("regression: hides the exact mid-stream chunk observed in live testing", () => {
    const acc =
      '...</html>\n```\n\nNEXT_ASKS: "Can you add some colorful flowers that give extra points?" | "Make';
    expect(hidePartialNextAskLine(acc)).toBe("...</html>\n```");
  });
});
