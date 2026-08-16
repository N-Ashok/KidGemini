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

describe("engineer's prose is not kid prose (2026-08-16, production)", () => {
  // Owner, mid-play, in production:
  //   "🛠️🏆 Pinpointing Draw Call Sources I'm now identifying the root cause
  //    of the draw calls."
  // Clean English, no code punctuation — CODE_LIKE could never object. The
  // filter had only ever asked "is this code?", never "is this about the
  // child's game?", and on a surface a child reads the second question is the
  // one that matters.
  it("rejects the exact line the owner saw", () => {
    expect(
      kidThoughtLine("Pinpointing Draw Call Sources I'm now identifying the root cause of the draw calls."),
    ).toBeNull();
  });

  for (const jargon of [
    "I am identifying the root cause of the slowdown now.",
    "Refactoring the scene to reduce draw calls.",
    "Merging the repeated meshes into one instanced mesh.",
    "Checking the WebGL context and the canvas size.",
    "The frame rate is low so I will optimise the geometry.",
    "Parsing the html to find the syntax error.",
  ]) {
    it(`rejects: ${jargon}`, () => expect(kidThoughtLine(jargon)).toBeNull());
  }

  // The filter must not become so eager that nothing reaches the child — the
  // whole point of the narration is that SOMETHING true is on screen.
  for (const good of [
    "Adding the dinosaur to the jungle now",
    "Making the car go faster around the corners",
    "Painting the houses in the village",
    "Putting a scoreboard at the top of the screen",
  ]) {
    it(`still shows: ${good}`, () => expect(kidThoughtLine(good)).toBe(good));
  }

  it("takes a clean sentence sitting beside a jargon one", () => {
    // The per-sentence rule that already exists must keep working: reject the
    // engineering half, keep the half a child would like.
    expect(
      kidThoughtLine("Reducing the draw calls in the scene. Now I am adding the trees to the village."),
    ).toBe("Now I am adding the trees to the village.");
  });
});
