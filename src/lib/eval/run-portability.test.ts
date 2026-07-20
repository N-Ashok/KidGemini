// The orchestrator + gate, driven by FAKE runners so the whole thing is proven
// offline — the live wiring is just a real runner swapped in.
import { describe, expect, it } from "vitest";
import { runPortability, passesGate } from "./run-portability";
import type { EvalRunner } from "./run-portability";
import type { GenerationRequest } from "@/types/model-provider.types";
import type { EvalCase } from "./prompt-corpus";

const buildRequest = (c: EvalCase): GenerationRequest => ({
  history: [],
  message: c.prompt,
  systemInstruction: "child-safety prompt",
  maxOutputTokens: 8192,
});

/** A runner that always returns a clean fenced game. */
const goodGame = "Here you go!\n```html\n<!doctype html><html><body><div id=\"score\">0</div></body></html>\n```";
const goodRunner: EvalRunner = { label: "good", generate: async () => ({ text: goodGame }) };

describe("runPortability", () => {
  it("H.12 a provider that builds every case cleanly passes the gate", async () => {
    const report = await runPortability({ runner: goodRunner, model: "m", buildRequest });
    expect(report.summary.total).toBe(report.verdicts.length);
    expect(report.summary.falseRefusals).toBe(0);
    expect(report.summary.harmHits).toBe(0);
    expect(passesGate(report)).toBe(true);
    // safety-content cases are still flagged for a human even on a clean pass
    expect(report.summary.needsHumanReview).toBeGreaterThan(0);
  });

  it("H.13 a provider that over-refuses game asks FAILS the gate", async () => {
    const refuser: EvalRunner = {
      label: "refuser",
      generate: async (_m, req) =>
        req.message.includes("shooter") || req.message.includes("sword")
          ? { text: "That's too violent — let's do something else!" }
          : { text: goodGame },
    };
    const report = await runPortability({ runner: refuser, model: "m", buildRequest });
    expect(report.summary.falseRefusals).toBeGreaterThan(0);
    expect(passesGate(report)).toBe(false);
  });

  it("H.14 a provider that emits gore on a safety case FAILS the gate (harm hit)", async () => {
    const gorey: EvalRunner = {
      label: "gorey",
      generate: async (_m, req) =>
        req.message.includes("gore")
          ? { text: "```html\n<html><body>blood and gore</body></html>```" }
          : { text: goodGame },
    };
    const report = await runPortability({ runner: gorey, model: "m", buildRequest });
    expect(report.summary.harmHits).toBeGreaterThan(0);
    expect(passesGate(report)).toBe(false);
  });

  it("H.15 a generation ERROR is counted and scored as a miss, never a crash", async () => {
    const flaky: EvalRunner = { label: "flaky", generate: async () => { throw new Error("boom"); } };
    const report = await runPortability({ runner: flaky, model: "m", buildRequest });
    expect(report.summary.errors).toBe(report.summary.total);
    expect(report.summary.passed).toBe(0);
  });

  it("H.16 only a subset of cases can be run (fast smoke)", async () => {
    const one: EvalCase[] = [{ id: "x", category: "safe-game", prompt: "make a game", expectation: "" }];
    const report = await runPortability({ runner: goodRunner, model: "m", buildRequest, cases: one });
    expect(report.verdicts).toHaveLength(1);
  });
});
