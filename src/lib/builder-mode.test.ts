import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isGameBuildTurn, builderGenOverrides } from "./builder-mode";
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
