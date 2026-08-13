import { describe, expect, it } from "vitest";
import { editReplyProse, streamingDisplayText } from "./game-edit";
import { applyPatch } from "./repair-prompt";
import {
  NEXT_ASKS_PREFIX, hidePartialNextAskLine, parseNextAskLine, reclaimLeadingNextAsk, resolveNextAsk,
} from "./next-ask-sentinel";

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

// BUG-FIX-LOG 2026-08-13: a second placement failure, distinct from
// 2026-08-12's leaked-inside-the-fence bug — this time the model put the
// sentinel as the very FIRST line of its reply, before the ```html fence
// even opens. The existing trailing-only machinery (parseNextAskLine, the
// route's pre-strip guard) only ever looks at the LAST line, so a leading
// sentinel sailed straight into the chat bubble as raw, ugly text. This
// moves it to the end so everything downstream recovers it exactly as if
// the model had followed the instruction.
describe("reclaimLeadingNextAsk", () => {
  const VALID_LINE = `${NEXT_ASKS_PREFIX} Add a power-up | Make the dragon faster | What if it happened underwater?`;

  it("moves a leading sentinel line to the end", () => {
    const reply = `${VALID_LINE}\n\n\`\`\`html\n<!doctype html><html></html>\n\`\`\``;
    const result = reclaimLeadingNextAsk(reply);
    expect(result.startsWith(VALID_LINE)).toBe(false);
    expect(result.trimEnd().endsWith(VALID_LINE)).toBe(true);
    expect(result).toContain("```html");
  });

  it("the reclaimed text is recoverable by the SAME parseNextAskLine the trailing path uses", () => {
    const reply = `${VALID_LINE}\n\n\`\`\`html\n<!doctype html><html></html>\n\`\`\``;
    const parsed = parseNextAskLine(reclaimLeadingNextAsk(reply));
    expect(parsed).not.toBeNull();
    expect(parsed!.ideas).toEqual(["Add a power-up", "Make the dragon faster", "What if it happened underwater?"]);
  });

  it("is a no-op when the first line isn't the sentinel (the well-formed, trailing case)", () => {
    const reply = `Here's your game! 🎮\n\n${VALID_LINE}`;
    expect(reclaimLeadingNextAsk(reply)).toBe(reply);
  });

  it("is a no-op when the sentinel is the only line (nothing to move it ahead of)", () => {
    expect(reclaimLeadingNextAsk(VALID_LINE)).toBe(VALID_LINE);
  });

  it("is a no-op on plain prose with no sentinel at all", () => {
    const reply = "Here's your game! 🎮";
    expect(reclaimLeadingNextAsk(reply)).toBe(reply);
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

// BUG-FIX-LOG (kid report, 2026-07-28): "unrelated suggestions" appeared on a
// memory-game/turtle chat after an edit. Root cause: gemini.ts's configFor
// used to compute nextAsk from the feature flag ALONE, so every internal
// retry/regeneration one-shot (which reaches the same configFor, and whose
// forceFullRegen bypasses isEdit) silently got asked for NEXT_ASKS too — not
// just the primary stream the kid actually sees. resolveNextAsk requires an
// EXPLICIT per-call opt-in instead.
describe("resolveNextAsk — only an EXPLICIT opt-in may request NEXT_ASKS, never the flag alone", () => {
  it("true when explicitly asked for", () => {
    expect(resolveNextAsk(true)).toBe(true);
  });
  it("the actual bug: omitting the opt-in must default to false, not inherit the flag", () => {
    expect(resolveNextAsk(undefined)).toBe(false);
  });
  it("false stays false", () => {
    expect(resolveNextAsk(false)).toBe(false);
  });
});

// Owner approval 2026-07-28: edit turns get contextual suggestions too, via a
// single trailing line after the patch blocks. The line must be inert against
// the patch pipeline — these pin the parsing side of that claim.
describe("parseNextAskLine on an EDIT-shaped reply (trailing line after patch blocks)", () => {
  const EDIT_REPLY = [
    "I made the cards blue for you!",
    "<<<<<<< SEARCH",
    "  background: red;",
    "=======",
    "  background: blue;",
    ">>>>>>> REPLACE",
    `${NEXT_ASKS_PREFIX} Add a power-up | Make it faster | What if it was underwater?`,
  ].join("\n");

  it("extracts the ideas from after the last REPLACE", () => {
    const result = parseNextAskLine(EDIT_REPLY);
    expect(result).not.toBeNull();
    expect(result!.ideas).toHaveLength(3);
  });

  it("leaves the patch blocks byte-identical after stripping", () => {
    const cleaned = parseNextAskLine(EDIT_REPLY)!.cleanedText;
    expect(cleaned).toBe(
      "I made the cards blue for you!\n<<<<<<< SEARCH\n  background: red;\n=======\n  background: blue;\n>>>>>>> REPLACE",
    );
    // The sigils the patch regex anchors on must survive untouched.
    expect(cleaned).toContain("<<<<<<< SEARCH");
    expect(cleaned).toContain("=======");
    expect(cleaned).toContain(">>>>>>> REPLACE");
    expect(cleaned).not.toContain(NEXT_ASKS_PREFIX);
  });

  it("an edit reply WITHOUT the line is left exactly as-is", () => {
    const noLine = "I made the cards blue!\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE";
    expect(parseNextAskLine(noLine)).toBeNull();
  });

  // THE SAFETY CLAIM, asserted rather than argued: permitting a trailing line
  // must not change the patch outcome in ANY way. applyPatch anchors on the
  // SEARCH/REPLACE sigils and ignores surrounding text — this proves it end to
  // end, and would fail loudly if that ever stopped being true.
  it("applyPatch produces an IDENTICAL result with and without the trailing line", () => {
    const html = "<html><style>  background: red;</style></html>";
    const withLine = applyPatch(html, EDIT_REPLY);
    const without = applyPatch(html, parseNextAskLine(EDIT_REPLY)!.cleanedText);
    expect(withLine).toEqual(without);
    expect(withLine.ok).toBe(true);
    if (withLine.ok) {
      expect(withLine.mode).toBe("patch");
      expect(withLine.html).toContain("background: blue;");
      expect(withLine.html).not.toContain(NEXT_ASKS_PREFIX);
    }
  });

  // The kid must never see the line, even mid-stream: streamingDisplayText
  // cuts everything from the first `<<<<` onward, and the sentinel arrives
  // after the blocks — so it is already behind that cut.
  it("never leaks through the streaming display path", () => {
    expect(streamingDisplayText(EDIT_REPLY)).not.toContain(NEXT_ASKS_PREFIX);
    // …including while the line is still arriving token by token.
    const midStream = EDIT_REPLY.slice(0, EDIT_REPLY.indexOf("| Make it faster"));
    expect(streamingDisplayText(midStream)).not.toContain(NEXT_ASKS_PREFIX);
  });

  // And the final displayed prose is the one sentence only.
  it("never leaks through editReplyProse (what the child actually reads)", () => {
    expect(editReplyProse(EDIT_REPLY)).toBe("I made the cards blue for you!");
  });
});
