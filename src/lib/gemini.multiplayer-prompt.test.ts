// buildTurnSystemInstruction's multiplayer gate (PRD-MULTIPLAYER.md Phase 4):
// independent of the 3D/audio CatalogGates, defaults to true (the "fully
// unlocked" test/paid shape, same convention as prompt-catalog.test.ts).

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CHILD_SYSTEM_PROMPT, buildTurnSystemInstruction } from "./gemini";
import { MULTIPLAYER_PROMPT_SECTION } from "./multiplayer-prompt";

describe("buildTurnSystemInstruction — multiplayer gate (independent of 3D/audio)", () => {
  it("defaults to carrying the multiplayer section (fully-unlocked/test shape)", () => {
    const full = buildTurnSystemInstruction();
    expect(full).toContain(MULTIPLAYER_PROMPT_SECTION);
  });

  it("multiplayer=false, both catalog gates closed too → exactly the bare child prompt", () => {
    expect(buildTurnSystemInstruction({ three: false, audio: false }, undefined, false)).toBe(CHILD_SYSTEM_PROMPT);
  });

  it("multiplayer=true alone (a plain 2D multiplayer game) carries the section with no 3D/audio catalog", () => {
    const full = buildTurnSystemInstruction({ three: false, audio: false }, undefined, true);
    expect(full).toContain(MULTIPLAYER_PROMPT_SECTION);
    expect(full).not.toContain("USES_MODELS");
  });

  it("a 3D multiplayer game (e.g. \"3d 2-player racing\") carries both sections", () => {
    const full = buildTurnSystemInstruction({ three: true, audio: false }, undefined, true);
    expect(full).toContain(MULTIPLAYER_PROMPT_SECTION);
    expect(full).toContain("<!--USES_THREE-->");
  });
});
