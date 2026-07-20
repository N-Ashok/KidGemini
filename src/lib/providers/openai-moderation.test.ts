// Pins the OpenAI moderation pass — the layer that lets an OpenAI model
// legitimately claim `provider-enforced` safety (owner decision 2026-07-20,
// option A) instead of running with only the system prompt.
//
// The behaviour under test is mostly ABOUT NOT OVER-BLOCKING. Ari is a
// game-building app for 7–14s: safety.config.ts spells out that cartoon
// video-game action and fictional in-game weapons are NOT violations, and the
// Flash-Lite output monitor was deleted on 2026-07-09 precisely because it
// retracted harmless games like chess. A moderation pass that reintroduces
// that is a regression, not a safety win.
import { describe, expect, it } from "vitest";
import { OpenAIModerationClassifier } from "./openai-moderation";

/** Build a fake omni-moderation result with the given category scores. */
const scores = (s: Record<string, number>) => ({
  results: [{
    flagged: Object.values(s).some((v) => v > 0.5),
    category_scores: {
      sexual: 0, "sexual/minors": 0, harassment: 0, "harassment/threatening": 0,
      hate: 0, "hate/threatening": 0, illicit: 0, "illicit/violent": 0,
      "self-harm": 0, "self-harm/intent": 0, "self-harm/instructions": 0,
      violence: 0, "violence/graphic": 0,
      ...s,
    },
  }],
});

const withScores = (s: Record<string, number>) =>
  new OpenAIModerationClassifier({ moderate: async () => scores(s) });

const child = (text = "hi") => ({ text, origin: "child" as const });

describe("mapping — what blocks", () => {
  it("M.1 sexual content hard-blocks (ALWAYS_HARD_BLOCK category)", async () => {
    const v = await withScores({ sexual: 0.9 }).classify(child());
    expect(v.action).toBe("hard_block");
    expect(v.category).toBe("sexual");
    expect(v.severity).toBe("high");
  });

  it("M.2 any sexual/minors signal at all hard-blocks — no threshold, no tolerance", async () => {
    const v = await withScores({ "sexual/minors": 0.05 }).classify(child());
    expect(v.action).toBe("hard_block");
    expect(v.category).toBe("sexual");
  });

  it("M.3 self-harm hard-blocks", async () => {
    const v = await withScores({ "self-harm/intent": 0.8 }).classify(child());
    expect(v.action).toBe("hard_block");
    expect(v.category).toBe("self_harm");
  });

  it("M.4 hate and harassment block at a strict threshold", async () => {
    expect((await withScores({ hate: 0.6 }).classify(child())).action).not.toBe("allow");
    expect((await withScores({ harassment: 0.6 }).classify(child())).action).not.toBe("allow");
  });
});

describe("mapping — what must NOT block (the 2026-07-09 lesson)", () => {
  it("M.5 moderate cartoon-violence scores stay ALLOWED — 'make me a shooting game' is an arcade staple", async () => {
    // Mirrors Gemini's DANGEROUS_CONTENT at BLOCK_MEDIUM_AND_ABOVE rather than LOW.
    const v = await withScores({ violence: 0.55 }).classify(child("make me a space shooter game"));
    expect(v.action).toBe("allow");
  });

  it("M.6 fictional in-game weapons stay ALLOWED at moderate illicit scores", async () => {
    const v = await withScores({ illicit: 0.5 }).classify(child("add a laser sword to my game"));
    expect(v.action).toBe("allow");
  });

  it("M.7 genuinely graphic violence still blocks — the carve-out is not a blank cheque", async () => {
    const v = await withScores({ "violence/graphic": 0.95 }).classify(child());
    expect(v.action).not.toBe("allow");
  });

  it("M.8 a clean result is allowed with no category", async () => {
    const v = await withScores({}).classify(child("how do penguins swim?"));
    expect(v.action).toBe("allow");
    expect(v.category).toBeNull();
  });
});

describe("fail closed", () => {
  it("M.9 a moderation API error blocks — never serves unchecked text to a child", async () => {
    const c = new OpenAIModerationClassifier({
      moderate: async () => { throw new Error("503 upstream down"); },
    });
    const v = await c.classify(child());
    expect(v.action).toBe("hard_block");
    expect(v.severity).toBe("high");
  });

  it("M.10 a malformed/empty response blocks rather than being read as 'clean'", async () => {
    const c = new OpenAIModerationClassifier({ moderate: async () => ({ results: [] }) as never });
    expect((await c.classify(child())).action).toBe("hard_block");
  });

  it("M.11 a missing API key blocks rather than silently skipping moderation", async () => {
    const c = new OpenAIModerationClassifier({ env: {} });
    expect((await c.classify(child())).action).toBe("hard_block");
  });
});

describe("both directions are checked", () => {
  it("M.12 model output is classified too — this replaces Gemini's inline safetySettings", async () => {
    const v = await withScores({ sexual: 0.9 }).classify({ text: "…", origin: "model" });
    expect(v.action).toBe("hard_block");
  });
});
