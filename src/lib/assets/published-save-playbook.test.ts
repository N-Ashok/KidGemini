// Contract tests for the published-game save/continue playbook (2026-08-04,
// docs/2026-08-01_PRD_SaveContinueBuilding.md §8, TECH_DEBT #27/#70). Wired
// into buildTurnSystemInstruction() via the SAME `gates.save` as
// save-state-playbook.ts — see catalog-gate.test.ts for the gate's own
// trigger/artifact matrix; this file pins the section's content and its
// wiring/cache contract.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PUBLISHED_SAVE_PROMPT_SECTION } from "./published-save-playbook";
import { SAVE_STATE_PROMPT_SECTION } from "./save-state-playbook";
import { buildTurnSystemInstruction } from "../gemini";

describe("PUBLISHED_SAVE_PROMPT_SECTION — the direct SDK contract", () => {
  it("teaches confirmResume() at startup, non-blocking (never awaited before the loop starts)", () => {
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/Ariantra\.confirmResume\(\)/);
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/Ariantra\.ready\(\)\.then/);
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/never await this|non-blocking/i);
  });

  it("teaches autosave() called once at startup, not inside the game loop", () => {
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/Ariantra\.autosave\(/);
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/once,\s*at\s*startup/i);
  });

  it("says confirmResume() already shows its own continue/start-fresh UI — never build a duplicate", () => {
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/Continue where you left off/i);
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/do not build your own confirmation UI/i);
  });

  it("shares state with the postMessage payload instead of tracking it twice", () => {
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/currentWorldState/);
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/SAME.*postMessage payload|same shape as the/i);
  });

  it("is explicitly additive — never framed as a replacement for the postMessage handlers", () => {
    expect(PUBLISHED_SAVE_PROMPT_SECTION).toMatch(/in addition to \(never instead of\)/i);
  });
});

describe("PUBLISHED_SAVE_PROMPT_SECTION — cache + phase-boundary contract", () => {
  it("is a static constant: it can never vary with the child's message", () => {
    // Same rule as SAVE_STATE_PROMPT_SECTION/PHYSICS_PROMPT_SECTION — a
    // per-message system prompt breaks the Gemini prefix cache on everything
    // behind it (COST_TOKEN_BUDGET.md #4).
    expect(typeof PUBLISHED_SAVE_PROMPT_SECTION).toBe("string");
    expect(PUBLISHED_SAVE_PROMPT_SECTION).not.toMatch(/\$\{/);
  });

  it("stays inside a reasonable token budget of its own, measured not guessed", () => {
    expect(Math.ceil(PUBLISHED_SAVE_PROMPT_SECTION.length / 4)).toBeLessThanOrEqual(400);
  });

  it("rides the save gate — a locked turn stays byte-identical to the bare prompt", () => {
    const locked = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false);
    expect(locked).not.toContain(PUBLISHED_SAVE_PROMPT_SECTION);
  });

  it("is sent alongside SAVE_STATE_PROMPT_SECTION on an unlocked build turn — additive, not either/or", () => {
    const full = buildTurnSystemInstruction({ three: false, audio: false, save: true }, false);
    expect(full).toContain(SAVE_STATE_PROMPT_SECTION);
    expect(full).toContain(PUBLISHED_SAVE_PROMPT_SECTION);
    // SAVE_STATE_PROMPT_SECTION (in-chat contract) comes first, so a game
    // reads "here's the chat contract" before "here's the published one".
    expect(full.indexOf(SAVE_STATE_PROMPT_SECTION)).toBeLessThan(full.indexOf(PUBLISHED_SAVE_PROMPT_SECTION));
  });

  it("gates independently of three/audio — a 2D building game gets the clause with neither engine nor sound", () => {
    const full = buildTurnSystemInstruction({ three: false, audio: false, save: true }, false);
    expect(full).toContain(PUBLISHED_SAVE_PROMPT_SECTION);
    expect(full).not.toContain("<!--USES_THREE-->");
  });
});
