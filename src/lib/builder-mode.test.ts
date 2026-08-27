import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isGameBuildTurn, builderGenOverrides, THREE_WANT_RE } from "./builder-mode";
import type { ChatMessage } from "@/types/chat.types";

// Middle-path thinking (owner decision 2026-07-09): ordinary chat keeps
// thinkingBudget 0 for instant first-token; GAME-BUILD turns get a bounded
// budget + more output headroom — the two config knobs that separate
// gemini.google.com's Flash code quality from ours on the same model.

const msg = (role: "child" | "assistant", text: string, artifactHtml?: string): ChatMessage => ({
  id: crypto.randomUUID(), role, text, artifactHtml, createdAt: 1,
});

describe("isGameBuildTurn — which turns pay for thinking", () => {
  it("detects an explicit game request", () => {
    expect(isGameBuildTurn("make me a space game", [])).toBe(true);
    expect(isGameBuildTurn("can you build a puzzle GAME please", [])).toBe(true);
  });

  it("detects iteration on an existing game even without the word", () => {
    const history = [msg("child", "make me a runner"), msg("assistant", "here!", "<html>…</html>")];
    expect(isGameBuildTurn("make the player jump higher", history)).toBe(true);
  });

  it("plain chat stays in fast mode", () => {
    expect(isGameBuildTurn("what is 7 times 8?", [])).toBe(false);
    expect(isGameBuildTurn("tell me about dragons", [msg("child", "hi"), msg("assistant", "hello!")])).toBe(false);
  });

  it("a bare '3d …' phrase is a game ask — the gallery teaches exactly these magic words (2026-07-12)", () => {
    expect(isGameBuildTurn("3d cars", [])).toBe(true);
    expect(isGameBuildTurn("3D dinos please!", [])).toBe(true);
    // "3d" must be a whole token — no false trigger inside another word.
    expect(isGameBuildTurn("i am in grade3d section", [])).toBe(false);
  });
});

describe("builderGenOverrides — env-tunable, sane defaults", () => {
  it("defaults: bounded thinking (1024, owner decision 2026-07-11 — faster first code) + large output headroom", () => {
    const o = builderGenOverrides({});
    expect(o.thinkingConfig.thinkingBudget).toBe(1024);
    expect(o.maxOutputTokens).toBe(24576);
  });

  it("asks for thought summaries — the kid-facing planning line needs them (2026-07-11)", () => {
    expect(builderGenOverrides({}).thinkingConfig.includeThoughts).toBe(true);
  });

  it("reads the env knobs when set", () => {
    const o = builderGenOverrides({ GEMINI_BUILDER_THINKING_BUDGET: "4096", GEMINI_BUILDER_MAX_OUTPUT_TOKENS: "32768" });
    expect(o.thinkingConfig.thinkingBudget).toBe(4096);
    expect(o.maxOutputTokens).toBe(32768);
  });

  it("falls back to defaults on junk env values (never NaN into the API)", () => {
    const o = builderGenOverrides({ GEMINI_BUILDER_THINKING_BUDGET: "lots", GEMINI_BUILDER_MAX_OUTPUT_TOKENS: "-5" });
    expect(o.thinkingConfig.thinkingBudget).toBe(1024);
    expect(o.maxOutputTokens).toBe(24576);
  });
});

// 2026-08-25 PRD_EditTurnCost §4.B: an edit turn is a SEARCH/REPLACE patch
// against a source the model is reading verbatim — it needs far less thinking
// than a fresh build. Prod showed 2–4× the build budget being spent on edits.
describe("builderGenOverrides — edit turns get their own, smaller thinking budget", () => {
  it("E.1 default edit budget is 512 (build stays 1024)", () => {
    expect(builderGenOverrides({}, { isEdit: true }).thinkingConfig.thinkingBudget).toBe(512);
    expect(builderGenOverrides({}, { isEdit: false }).thinkingConfig.thinkingBudget).toBe(1024);
    expect(builderGenOverrides({}).thinkingConfig.thinkingBudget).toBe(1024);
  });

  it("E.2 GEMINI_EDIT_THINKING_BUDGET overrides the edit budget only", () => {
    const env = { GEMINI_EDIT_THINKING_BUDGET: "768" };
    expect(builderGenOverrides(env, { isEdit: true }).thinkingConfig.thinkingBudget).toBe(768);
    expect(builderGenOverrides(env, { isEdit: false }).thinkingConfig.thinkingBudget).toBe(1024);
  });

  it("E.3 junk edit budget falls back to the default, never NaN", () => {
    expect(builderGenOverrides({ GEMINI_EDIT_THINKING_BUDGET: "lots" }, { isEdit: true }).thinkingConfig.thinkingBudget).toBe(512);
  });

  it("E.4 edit turns keep thought summaries and the full output headroom (a patch can be big)", () => {
    const o = builderGenOverrides({}, { isEdit: true });
    expect(o.thinkingConfig.includeThoughts).toBe(true);
    expect(o.maxOutputTokens).toBe(24576);
  });
});

// 2026-08-27 (owner): a first-time child gets a 2D game; 3D is for when they
// ASK for it — literally ("3D") or in kid words about looks ("realistic",
// "real life", "better graphics"). THREE_WANT_RE is that single definition,
// shared by the catalog gate and the 2D→3D conversion predicate.
describe("THREE_WANT_RE — the child asked for 3D, in 3D-words or in quality-words", () => {
  it("Q.1 literal 3D spellings still match (the 2026-08-09 'Calvin' class)", () => {
    for (const t of ["make it 3d", "Make it 3-D", "a three dimensional game"]) expect(THREE_WANT_RE.test(t), t).toBe(true);
  });
  it("Q.2 quality words match: realistic / real life / lifelike / better|real graphics / look(s) real", () => {
    for (const t of [
      "make it realistic", "a real life car game", "make the dino look real", "can it have better graphics",
      "real graphics please", "make it lifelike", "more realistic please", "good graphics like a real game",
    ]) expect(THREE_WANT_RE.test(t), t).toBe(true);
  });
  it("Q.3 ordinary asks do NOT match — 'car game', 'really fun', 'real names', 'graph'", () => {
    for (const t of ["make a car game", "make it really fun", "use real names of animals", "a game with a bar graph", "is that real?"])
      expect(THREE_WANT_RE.test(t), t).toBe(false);
  });
});
