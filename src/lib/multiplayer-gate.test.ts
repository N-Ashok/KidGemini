// Multiplayer prompt gate (PRD-MULTIPLAYER.md Phase 4, Ariantra-Platform repo).
// Nested under the build-turn gate so chit-chat pays zero tokens (same
// discipline as catalog-gate.ts, TECH_DEBT #33) — independent of 3D/audio,
// since a multiplayer game can be plain 2D and silent.

import { describe, it, expect } from "vitest";
import { multiplayerGate } from "./multiplayer-gate";
import type { ChatMessage } from "@/types/chat.types";

const msg = (role: "child" | "assistant", text: string, artifactHtml?: string): ChatMessage =>
  ({ role, text, artifactHtml }) as ChatMessage;

describe("multiplayerGate — the build-turn gate comes first", () => {
  it("a chit-chat turn never unlocks it", () => {
    expect(multiplayerGate({ message: "let's play multiplayer sometime", history: [] })).toBe(false);
  });
});

describe("multiplayerGate — keyword triggers on a build turn", () => {
  it("a plain game ask unlocks nothing (today's single-player product, unchanged)", () => {
    expect(multiplayerGate({ message: "make me a platformer game", history: [] })).toBe(false);
  });

  for (const ask of [
    "make a multiplayer racing game",
    "a 2-player game I can play with my friend",
    "a two player game",
    "make a co-op dungeon game",
    "a game where I can race against my friend",
    "make it a versus mode game, me vs my brother",
    "a game we can play together",
  ]) {
    it(`"${ask}" unlocks it`, () => {
      expect(multiplayerGate({ message: ask, history: [] })).toBe(true);
    });
  }

  it("does not fire inside unrelated words", () => {
    expect(multiplayerGate({ message: "make a game about versatile athletes", history: [] })).toBe(false);
  });
});

describe("multiplayerGate — iteration turns keep it unlocked (history scan)", () => {
  const builtMp: ChatMessage[] = [
    msg("child", "a 2-player racing game"),
    msg("assistant", "Here's your game! 🎮", "<!doctype html><html>…</html>"),
  ];

  it('"make it faster" after a multiplayer ask keeps it unlocked', () => {
    expect(multiplayerGate({ message: "make it faster", history: builtMp })).toBe(true);
  });

  it("a prior artifact carrying USES_MULTIPLAYER keeps it unlocked even if the keyword text is gone", () => {
    const history = [msg("assistant", "Here's your game! 🎮", "<html><!--USES_MULTIPLAYER--><canvas></canvas></html>")];
    expect(multiplayerGate({ message: "add a second level", history })).toBe(true);
  });

  it("iterating on a plain single-player game stays locked", () => {
    const history = [msg("child", "make me a maze game"), msg("assistant", "Here's your game! 🎮", "<html><canvas></canvas></html>")];
    expect(multiplayerGate({ message: "add more walls", history })).toBe(false);
  });
});
