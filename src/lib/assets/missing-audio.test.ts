// Missing-sound register (owner decision 2026-08-29): when a generated game
// asks for a sound we do not have, do NOT substitute one — play nothing, and
// RECORD the miss. The misses become the weekly shopping list for the asset
// library. Nothing about this is ever shown to a child.
//
// Measured cause: 4 of 25 production games with audio (16%) call at least one
// name that does not exist — bg_loop_adventure, apple, bump, shoot, move,
// push, lose. An unknown name is only a console.warn at runtime, so the game
// ships silent and every check we own passes it.
import { describe, it, expect } from "vitest";
import { missingAudioNames } from "./missing-audio";

const KNOWN = ["jump", "coin_pickup", "win", "bg_loop_upbeat", "bg_loop_playful"];

describe("missingAudioNames", () => {
  it("MA.1 finds a music name that is not in the library, and says it is music", () => {
    const out = missingAudioNames(`playMusic("bg_loop_adventure"); playSound("jump");`, KNOWN);
    expect(out).toEqual([{ name: "bg_loop_adventure", kind: "music" }]);
  });

  it("MA.2 finds invented sound effects and keeps them distinct", () => {
    const out = missingAudioNames(`playSound('bump'); playSound("shoot"); playSound(\`bump\`);`, KNOWN);
    expect(out.map((x) => x.name).sort()).toEqual(["bump", "shoot"]);
    expect(out.every((x) => x.kind === "sfx")).toBe(true);
  });

  it("MA.3 says nothing when every name exists — the common case must be free", () => {
    expect(missingAudioNames(`playSound("jump"); playMusic("bg_loop_upbeat");`, KNOWN)).toEqual([]);
  });

  it("MA.4 a game with no audio at all yields nothing", () => {
    expect(missingAudioNames("<html><body>no audio here</body></html>", KNOWN)).toEqual([]);
  });

  it("MA.5 ignores our own runtime helper's definition, not just its call sites", () => {
    // runtime-helpers.ts injects `window.playSound = function (name, opts)` —
    // that must never be mistaken for a game asking for a sound called "name".
    const runtime = `window.playSound = function (name, opts) { load(name); };
                     window.playMusic = function (name) { load(name); };`;
    expect(missingAudioNames(runtime, KNOWN)).toEqual([]);
  });

  it("MA.6 is case-sensitive and does not invent matches", () => {
    expect(missingAudioNames(`playSound("Jump");`, KNOWN)).toEqual([{ name: "Jump", kind: "sfx" }]);
  });
});
