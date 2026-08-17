// Pins the keyword→emoji labeling pass over an already kid-safe thought line
// (docs/2026-07-31_PRD_BuildProgressNarration.md). This runs AFTER
// kidThoughtLine() has already filtered the text — buildStepLabel() never
// re-validates safety, it only picks a matching emoji so the same live build
// signal narrates "what's happening right now" instead of a generic caption.
// Fails closed: no keyword match still returns a usable generic label, never
// a missing/blank emoji.
import { describe, expect, it } from "vitest";
import { buildStepLabel, buildUpdatingLine } from "./build-narration";

describe("buildStepLabel", () => {
  it("matches a keyword and returns its emoji", () => {
    expect(buildStepLabel("I'll add the dinosaur running across the screen")).toEqual({
      emoji: "🦖",
      text: "I'll add the dinosaur running across the screen",
    });
  });

  it("is case-insensitive", () => {
    expect(buildStepLabel("Building the STADIUM now")).toEqual({
      emoji: "🏟️",
      text: "Building the STADIUM now",
    });
  });

  it("matches on a substring, not just a whole word boundary trap", () => {
    expect(buildStepLabel("Making the bat swing feel snappier")).toEqual({
      emoji: "🏏",
      text: "Making the bat swing feel snappier",
    });
  });

  it("falls back to a generic emoji when nothing matches", () => {
    expect(buildStepLabel("Adjusting the physics values")).toEqual({
      emoji: "🛠️",
      text: "Adjusting the physics values",
    });
  });

  it("falls back to generic on an empty string, never throwing", () => {
    expect(buildStepLabel("")).toEqual({ emoji: "🛠️", text: "" });
  });

  it("picks whichever keyword appears first in the table when several match", () => {
    // "dinosaur" is listed before "sound" in the table (docs §3) — first match wins.
    expect(buildStepLabel("the dinosaur makes a sound when it jumps").emoji).toBe("🦖");
  });

  const table: Array<[string, string]> = [
    ["dinosaur", "🦖"],
    ["field", "🏟️"],
    ["arena", "🏟️"],
    ["swing", "🏏"],
    ["sound", "🔊"],
    ["audio", "🔊"],
    ["music", "🔊"],
    ["score", "🏆"],
    ["point", "🏆"],
    ["jump", "🦘"],
    ["hop", "🦘"],
    ["color", "🎨"],
    ["paint", "🎨"],
    ["ball", "⚾"],
    ["sky", "☁️"],
    ["background", "☁️"],
    ["character", "🧍"],
    ["player", "🧍"],
    ["enemy", "👾"],
    ["monster", "👾"],
  ];
  it.each(table)("maps a line containing %s to %s", (keyword, emoji) => {
    expect(buildStepLabel(`Working on the ${keyword} part`).emoji).toBe(emoji);
  });
});

// BUG-FIX-LOG 2026-07-31: small edits often produce a thought line too short
// or code-like for kidThoughtLine() to pass, so thinkingLine stays null and
// the strip fell back to a generic caption with no derived emoji at all — the
// owner never saw anything change for "add buildings and grass". The kid's
// OWN request text is always available (no safety filter can reject it away
// here — it already passed the input gate), so it's the guaranteed fallback.
describe("buildUpdatingLine", () => {
  it("prefers the live thought line when one exists", () => {
    expect(buildUpdatingLine({ thinkingLine: "Adding the dinosaur now", askText: "make it faster" })).toBe(
      "🦖 Adding the dinosaur now",
    );
  });

  it("falls back to the kid's own ask, still emoji-tagged, when there's no thought line", () => {
    expect(buildUpdatingLine({ thinkingLine: null, askText: "add buildings and grass to the road" })).toBe(
      '🛠️ Making "add buildings and grass to the road" — you can keep playing this one! ✨',
    );
  });

  it("tags the ask-text fallback with a matching keyword emoji", () => {
    expect(buildUpdatingLine({ thinkingLine: null, askText: "make the dinosaur jump higher" })).toBe(
      '🦖 Making "make the dinosaur jump higher" — you can keep playing this one! ✨',
    );
  });

  it("truncates a long ask in the fallback line", () => {
    const long = "a".repeat(60);
    const result = buildUpdatingLine({ thinkingLine: null, askText: long });
    expect(result).toBe(`🛠️ Making "${"a".repeat(48)}…" — you can keep playing this one! ✨`);
  });

  it("returns undefined when neither a thought line nor an ask exists", () => {
    expect(buildUpdatingLine({ thinkingLine: null, askText: null })).toBeUndefined();
  });

  it("treats an empty-string ask the same as no ask", () => {
    expect(buildUpdatingLine({ thinkingLine: null, askText: "" })).toBeUndefined();
  });
});
