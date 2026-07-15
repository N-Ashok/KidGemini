// Prompt-contract test for the multiplayer section (PRD-MULTIPLAYER.md Phase
// 4, Ariantra-Platform repo): the marker must be taught, and the corrected
// Phase 3 ownership contract (the platform's overlay owns host()/join(), the
// game never calls them) must be pinned — losing this silently would have the
// model write its own host()/join() calls that race the injected overlay for
// the same session.

import { describe, it, expect } from "vitest";
import { MULTIPLAYER_PROMPT_SECTION } from "./multiplayer-prompt";
import { MULTIPLAYER_MARKER } from "./multiplayer-gate";

describe("MULTIPLAYER_PROMPT_SECTION — marker contract", () => {
  it("teaches the exact opt-in marker ArtifactFrame checks for (MULTIPLAYER_MARKER)", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toContain(MULTIPLAYER_MARKER);
  });
});

describe("MULTIPLAYER_PROMPT_SECTION — overlay ownership (Phase 3 correction)", () => {
  it("forbids the game from calling host()/join() itself", () => {
    // \s+ between words: the prompt is a wrapped template literal and a
    // re-wrap must not break this pin (convention: gemini.prompt.test.ts).
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/never\s+call\s+`?Ariantra\.host\(\)/i);
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/never\s+build\s+your\s+own\s+lobby/i);
  });

  it("teaches only broadcast()/onMessage()/onPlayers() — never mentions calling host()/join() as something the game does", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("Ariantra.broadcast(");
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("Ariantra.onMessage(");
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("Ariantra.onPlayers(");
  });

  it("teaches the host-authoritative pattern", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/host-authoritative/i);
  });

  it("requires the game to still work alone before a friend joins (no dead single-player state)", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/work,? alone/i);
  });
});
