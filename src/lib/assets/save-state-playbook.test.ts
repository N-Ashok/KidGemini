// Contract tests for the save/continue-building playbook (2026-08-03,
// docs/2026-08-01_PRD_SaveContinueBuilding.md §3a, §5). Wired into
// buildTurnSystemInstruction() via `gates.save` (catalog-gate.ts) as of
// Phase 2 — see catalog-gate.test.ts for the gate's own trigger/artifact
// matrix; this file pins the section's content and its wiring/cache contract.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SAVE_STATE_PROMPT_SECTION } from "./save-state-playbook";
import { buildTurnSystemInstruction } from "../gemini";

describe("SAVE_STATE_PROMPT_SECTION — the postMessage contract", () => {
  it("teaches listening for a save request and replying with the state", () => {
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/ariantra:request-save/);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/ariantra:save-state/);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/postMessage/);
  });

  it("teaches restoring from the injected initial-state global on boot", () => {
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/__ARIANTRA_INITIAL_STATE__/);
  });
});

describe("SAVE_STATE_PROMPT_SECTION — save the whole world, not the current view", () => {
  it("states the rule explicitly: every area, not just the one on screen", () => {
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/whole world|everything the player has ever built/i);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/multiple distinct areas|travel and\s+build/i);
  });

  it("gives the two-area JSON example so the model doesn't default to a single flat list", () => {
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/"areas"/);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/"city-1"/);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/"city-2"/);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/originX/);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/originZ/);
  });

  it("names the specific trap: saving only the area the player is standing in", () => {
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/silently loses every other area/i);
  });

  it("says each object carries its own position/rotation so restore places it exactly", () => {
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/rotation/);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/own position/i);
  });
});

describe("SAVE_STATE_PROMPT_SECTION — the marker is earned, not assumed", () => {
  it("names the literal marker comment", () => {
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/<!--SUPPORTS_SAVE-->/);
  });

  it("states the marker is emitted ONLY when both handlers are implemented", () => {
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/if,\s*and\s*only\s*if/i);
    expect(SAVE_STATE_PROMPT_SECTION).toMatch(/never emit it as a courtesy/i);
  });
});

describe("SAVE_STATE_PROMPT_SECTION — cache + phase-boundary contract", () => {
  it("is a static constant: it can never vary with the child's message", () => {
    // Same rule as PHYSICS_PROMPT_SECTION/SPORTS_PLAYBOOK — a per-message
    // system prompt breaks the Gemini prefix cache on everything behind it
    // (COST_TOKEN_BUDGET.md #4). Load-bearing for whenever this gets wired in.
    expect(typeof SAVE_STATE_PROMPT_SECTION).toBe("string");
    expect(SAVE_STATE_PROMPT_SECTION).not.toMatch(/\$\{/);
  });

  it("stays inside a token budget of its own, measured not guessed", () => {
    // Measured at 493 tokens on first draft (2026-08-03). This now rides
    // every build/world turn (gates.save), so the budget is set from the
    // real value: a future breach means content was ADDED and needs its own
    // justification, same rule as PHYSICS_PROMPT_SECTION.
    expect(Math.ceil(SAVE_STATE_PROMPT_SECTION.length / 4)).toBeLessThanOrEqual(500);
  });

  it("rides the save gate — a locked turn stays byte-identical to the bare prompt", () => {
    const locked = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false);
    expect(locked).not.toContain(SAVE_STATE_PROMPT_SECTION);
  });

  it("is actually sent on an unlocked build turn (a section nobody wires in is worthless)", () => {
    expect(buildTurnSystemInstruction()).toContain(SAVE_STATE_PROMPT_SECTION);
    expect(buildTurnSystemInstruction({ three: false, audio: false, save: true }, false)).toContain(SAVE_STATE_PROMPT_SECTION);
  });

  it("gates independently of three/audio — a 2D building game gets the clause with neither engine nor sound", () => {
    const full = buildTurnSystemInstruction({ three: false, audio: false, save: true }, false);
    expect(full).toContain(SAVE_STATE_PROMPT_SECTION);
    expect(full).not.toContain("<!--USES_THREE-->");
  });
});
