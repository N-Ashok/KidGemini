// injectInitialGameState — the parent-side half of the save contract
// (docs/2026-08-01_PRD_SaveContinueBuilding.md §3f): injects
// window.__ARIANTRA_INITIAL_STATE__ before the game's own script runs, same
// marker+anchor+escape pattern as preview-runtime.ts's injectPreviewRuntime.

import { describe, it, expect } from "vitest";
import { INITIAL_GAME_STATE_MARKER, injectInitialGameState } from "./game-save-inject";
import type { GameSaveState } from "@/types/game-save.types";

const DOC = "<!doctype html><html><head><title>Game</title></head><body>GAME BODY<script>startGame()</script></body></html>";

const state: GameSaveState = {
  areas: [{ id: "city-1", originX: 0, originZ: 0, objects: [{ type: "block", x: 1, y: 0, z: 1, rotation: 0 }] }],
};

describe("injectInitialGameState", () => {
  it("injects the marker and the global right after <head>, before any game code", () => {
    const out = injectInitialGameState(DOC, state);
    expect(out).toContain(INITIAL_GAME_STATE_MARKER);
    expect(out).toContain("window.__ARIANTRA_INITIAL_STATE__");
    const headEnd = out.indexOf("<head>") + "<head>".length;
    expect(out.indexOf(INITIAL_GAME_STATE_MARKER)).toBe(headEnd);
    expect(out.indexOf("window.__ARIANTRA_INITIAL_STATE__")).toBeLessThan(out.indexOf("startGame()"));
  });

  it("the injected global deep-equals the state handed in, once JSON.parsed", () => {
    const out = injectInitialGameState(DOC, state);
    const match = out.match(/window\.__ARIANTRA_INITIAL_STATE__=(\{.*?\});/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(state);
  });

  it("falls back to right after <html>, then prepends, when there is no <head>", () => {
    expect(injectInitialGameState("<html><body>x</body></html>", state)).toContain(INITIAL_GAME_STATE_MARKER);
    const noHtml = injectInitialGameState("<div>bare</div>", state);
    expect(noHtml.indexOf(INITIAL_GAME_STATE_MARKER)).toBe(0);
    expect(noHtml).toContain("<div>bare</div>");
  });

  it("preserves the original game markup", () => {
    const out = injectInitialGameState(DOC, state);
    expect(out).toContain("GAME BODY");
    expect(out).toContain("startGame()");
  });

  it("is idempotent — a second pass never double-injects", () => {
    const once = injectInitialGameState(DOC, state);
    const twice = injectInitialGameState(once, state);
    expect(twice).toBe(once);
  });

  it("neutralizes a </script> hiding inside the kid's own save data — never terminates the tag early", () => {
    const spicy: GameSaveState = {
      areas: [{ id: "a", originX: 0, originZ: 0, objects: [{ note: "</script><script>alert(1)</script>" }] }],
    };
    const out = injectInitialGameState(DOC, spicy);
    const injected = out.slice(out.indexOf(INITIAL_GAME_STATE_MARKER), out.indexOf("startGame()"));
    // Exactly one real closing tag in the injected block — the state script's own.
    expect((injected.match(/<\/script>/g) ?? []).length).toBe(1);
    // ...and the payload still round-trips to the original string once parsed
    // back out (JSON.parse undoes JSON's own escaping; the inline-script
    // escape only protects the surrounding HTML, not the JSON content).
    const match = out.match(/window\.__ARIANTRA_INITIAL_STATE__=(\{[\s\S]*?\});\s*<\/script>/);
    expect(JSON.parse(match![1]!)).toEqual(spicy);
  });
});
