// Multiplayer prompt gate (PRD-MULTIPLAYER.md Phase 4, Ariantra-Platform repo).
// Nested under the build-turn gate so chit-chat pays zero tokens (same
// discipline as catalog-gate.ts, TECH_DEBT #33) — independent of 3D/audio,
// since a multiplayer game can be plain 2D and silent.

import { describe, it, expect } from "vitest";
import { ensureMultiplayerMarker, multiplayerGate } from "./multiplayer-gate";
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

// Owner UAT 2026-07-18 (screenshot: "asked for multiplayer capability, it did
// not even provide invite button"): the model wrote real multiplayer SDK code
// but forgot the <!--USES_MULTIPLAYER--> opt-in line, so the preview's
// "🎮 Invite" button (and publish-time lobby overlay) never appeared —
// working multiplayer with no way to use it. The marker is now guaranteed
// server-side whenever the delivered game actually calls the multiplayer SDK.
describe("ensureMultiplayerMarker — marker guaranteed when SDK multiplayer code exists", () => {
  it("adds the marker right after <body> when Ariantra multiplayer calls exist without it", () => {
    const html = "<html><body><script>Ariantra.broadcast({x:1});Ariantra.onMessage(function(m){});</script></body></html>";
    const out = ensureMultiplayerMarker(html);
    expect(out).toContain("<body><!--USES_MULTIPLAYER-->");
  });

  it("is a byte-identical no-op when the marker is already there", () => {
    const html = "<html><body><!--USES_MULTIPLAYER--><script>Ariantra.onMessage(function(m){});</script></body></html>";
    expect(ensureMultiplayerMarker(html)).toBe(html);
  });

  it("never touches a single-player game (no SDK multiplayer calls)", () => {
    const html = "<html><body><canvas></canvas></body></html>";
    expect(ensureMultiplayerMarker(html)).toBe(html);
  });

  it("handles a <body> tag with attributes", () => {
    const html = '<html><body class="game" onload="init()"><script>Ariantra.broadcast({});</script></body></html>';
    const out = ensureMultiplayerMarker(html);
    expect(out).toContain('<body class="game" onload="init()"><!--USES_MULTIPLAYER-->');
  });

  it("prepends when there is no <body> tag at all (fragment fail-soft)", () => {
    const html = "<script>Ariantra.onMessage(function(m){});</script>";
    expect(ensureMultiplayerMarker(html).startsWith("<!--USES_MULTIPLAYER-->")).toBe(true);
  });
});
