// Pins the child-safety system prompt that REPLACED the Flash-Lite output
// monitor (2026-07-09). If these lines disappear, the chat model loses its
// only per-generation child-safety instruction — that must fail loudly here.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CHILD_SYSTEM_PROMPT } from "./gemini";

describe("CHILD_SYSTEM_PROMPT (safety instruction, monitor replacement)", () => {
  it("states the audience is a child aged 7 to 14", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/child aged between 7 and 14/i);
  });
  it("carries the be-careful / be-cautious safety instruction", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/careful in the way you speak/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/cautious about safety/i);
  });
  it("forbids unsafe content and never refuses a game", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never produce anything scary, gory, sexual, hateful, or unsafe/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never refuse a game request/i);
  });
  it("never deflects a hard game to a simpler one (chess-deflection class, 2026-07-09)", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never (say|call) (a game is|it) too (complicated|complex|hard)/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/build the game the child asked for/i);
  });
  it("allows trusted CDN libraries for rule-heavy classics like chess", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/chess\.js/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/cdn/i);
  });
});
