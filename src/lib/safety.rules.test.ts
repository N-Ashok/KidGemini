import { describe, it, expect } from "vitest";
import { RulesClassifier } from "./safety.rules";

const rules = new RulesClassifier();
const child = (text: string) => rules.classifySync({ text, origin: "child" as const });

/** Production bug (2026-07-18): normalize() strips ALL whitespace before
 *  substring-matching BLOCK_WORDS, so two innocent whitespace-separated
 *  words can merge into a blocked one at their boundary — "medic kit" ->
 *  "medickit" contains "dick". Kept the space-stripping (needed to catch
 *  "f u c k" and the concatenated self-harm phrases below) but scoped the
 *  short profanity list to per-word matching instead of the whole string. */
describe("RulesClassifier — word-boundary false positives (BUG-FIX-LOG 2026-07-18)", () => {
  it("does not hard-block 'medic kit' — two real words colliding into 'dick' at the boundary", () => {
    const v = child("enemy can pick medic kit and increase his life");
    expect(v.action).toBe("allow");
  });

  it("a standalone blocked word is still caught even next to an innocent neighbor (not the boundary bug)", () => {
    expect(child("the class is titled sex ed").action).toBe("hard_block"); // "sex" is itself a real standalone blocked word
  });

  it("still hard-blocks letter-spaced evasion of a single word ('f u c k')", () => {
    expect(child("f u c k you").action).toBe("hard_block");
  });

  it("still hard-blocks punctuation-obfuscated profanity within one token ('d.i.c.k')", () => {
    expect(child("you are a d.i.c.k").action).toBe("hard_block");
  });

  it("still hard-blocks leetspeak within one token ('sh1t')", () => {
    expect(child("this is sh1t").action).toBe("hard_block");
  });

  it("still hard-blocks a plain single-word profanity match", () => {
    expect(child("you are an asshole").action).toBe("hard_block");
  });

  it("still hard-blocks self-harm phrases written across real word boundaries", () => {
    expect(child("i want to kill myself").action).toBe("hard_block");
    expect(child("i keep wanting to cut myself").action).toBe("hard_block");
  });

  it("allow is still the default for genuinely unremarkable text", () => {
    expect(child("can you add a jump button to my platformer game").action).toBe("allow");
  });
});

/** Production bug (KNOWN_BUGS #7 / #12, 2026-07-27): an oversized message
 *  (~100K chars of game source accidentally folded into a chat turn, see
 *  BUG-FIX-LOG same date) raised the odds of an accidental SELF_HARM
 *  whole-string substring hit. MAX_SCAN_CHARS bounds that unbounded scan —
 *  PROFANITY is already per-token and structurally safer, so only the
 *  whole-string SELF_HARM check needs a ceiling. */
describe("RulesClassifier — MAX_SCAN_CHARS backstop (KNOWN_BUGS #7/#12)", () => {
  it("still catches a self-harm phrase well within the ceiling", () => {
    const v = child("i want to kill myself " + "x".repeat(500));
    expect(v.action).toBe("hard_block");
  });

  it("catches a self-harm phrase placed inside the first 4000 chars of a huge message", () => {
    const padded = "a".repeat(1000) + "i want to kill myself" + "b".repeat(50_000);
    expect(child(padded).action).toBe("hard_block");
  });

  it("does NOT hard-block on a self-harm phrase that only appears well beyond the ceiling", () => {
    const padded = "a".repeat(10_000) + "i want to kill myself" + "b".repeat(90_000);
    expect(child(padded).action).toBe("allow");
  });

  it("does not false-positive on a huge benign payload (e.g. re-attached game source)", () => {
    const gameLikeSource = "<html><head></head><body>".repeat(4000);
    expect(child(gameLikeSource).action).toBe("allow");
  });

  it("still catches ordinary short profanity/self-harm messages unaffected by the ceiling", () => {
    expect(child("you are an asshole").action).toBe("hard_block");
    expect(child("i keep wanting to cut myself").action).toBe("hard_block");
  });
});
