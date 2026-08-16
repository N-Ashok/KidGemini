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

  it("does NOT quote a long ask — a chopped sentence reads as nonsense", () => {
    // Owner, from production: 🛠️🛠️ Making "The game is good only issue is that
    // the humans a…". Quoting the child's own words is right for a short
    // instruction and wrong for a sentence ABOUT the game: truncated, it
    // announces that we are building her complaint. Returning undefined hands
    // the caller its plain "Making your update…" line, which is always true.
    const long = "The game is good only issue is that the humans are floating above the road";
    expect(buildUpdatingLine({ thinkingLine: null, askText: long })).toBeUndefined();
  });

  it("still quotes an ask that fits", () => {
    expect(buildUpdatingLine({ thinkingLine: null, askText: "make the car red" })).toBe(
      '🛠️ Making "make the car red" — you can keep playing this one! ✨',
    );
  });

  it("a long ask never loses the LIVE thought line — that path is unchanged", () => {
    expect(
      buildUpdatingLine({ thinkingLine: "Adding the dinosaur now", askText: "x".repeat(200) }),
    ).toBe("🦖 Adding the dinosaur now");
  });

  it("returns undefined when neither a thought line nor an ask exists", () => {
    expect(buildUpdatingLine({ thinkingLine: null, askText: null })).toBeUndefined();
  });

  it("treats an empty-string ask the same as no ask", () => {
    expect(buildUpdatingLine({ thinkingLine: null, askText: "" })).toBeUndefined();
  });
});

describe("keyword emojis must match WORDS, not fragments (2026-08-16)", () => {
  // Owner, from production: "🛠️🏆 Pinpointing Draw Call Sources…" — the trophy
  // came from /point/ matching inside "Pinpointing".
  it("does not award a trophy for 'Pinpointing'", () => {
    expect(buildStepLabel("Pinpointing the problem").emoji).toBe("🛠️");
  });

  for (const [line, emoji] of [
    ["Shopping for new cars", "🛠️"],      // was 🦘 via /hop/
    ["Adding a football pitch", "🛠️"],    // was ⚾ via /ball/ … and 🏟️ via /field/? no: "pitch"
    ["Making it colorful", "🎨"],          // real match, kept
    ["Adding the score board", "🏆"],      // real match, kept
    ["Adding a big ball", "⚾"],           // real match, kept
    // jump is listed BEFORE character/player, so it wins — first-match order,
    // unchanged by this fix. (My first expectation here was wrong, not the code.)
    ["The players are jumping", "🦘"],
    ["Adding a new player", "🧍"],
  ] as const) {
    it(`${line} → ${emoji}`, () => expect(buildStepLabel(line).emoji).toBe(emoji));
  }
});
