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

  it("teaches broadcast()/onMessage()/onPlayers() — never mentions calling host()/join() as something the game does", () => {
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

describe("MULTIPLAYER_PROMPT_SECTION — own identity (BUG_LOG #22, Ariantra-Platform repo)", () => {
  // A real generated game invented its own random local id and tried to
  // match it against `players.map(p => p.id)` (a hallucinated field — the
  // real one is `playerId`) to tell its own roster row apart from a peer's.
  // It never matched, so the game silently treated the SDK's own onPlayers
  // cleanup logic as "no peers exist" and removed every other player's
  // avatar the instant it was created — multiplayer looked like solo play.
  it("teaches Ariantra.myPlayerId() so a game never has to invent its own id", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("Ariantra.myPlayerId(");
  });

  it("teaches the real onPlayers() roster field name — playerId, not id", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/`?playerId`?/);
  });
});

describe("MULTIPLAYER_PROMPT_SECTION — room capacity", () => {
  it("tells the model the real min/max player counts, so it never invents or hardcodes its own", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/at least 2 players/i);
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/never has more than 5/i);
  });
});

describe("MULTIPLAYER_PROMPT_SECTION — real player names (a live-tested gap)", () => {
  // Live UAT: a hand-written game correctly avoided the myPlayerId/id bug,
  // but still labeled every peer "Friend" — the SDK's onPlayers() roster
  // DOES carry the real displayName at runtime, but nothing in this prompt
  // ever told the model the field exists, so it fell back to a placeholder.
  it("teaches the displayName field on each onPlayers() roster entry", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/`?displayName`?/);
  });

  it("explicitly says never to use a generic placeholder like \"Friend\" for a peer's label", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/never label a peer with a generic word/i);
  });

  it("teaches re-deriving positioning/layout every time onPlayers fires, not only once at load", () => {
    // A different live-tested bug: a car spawned at {x:0,y:0} because it was
    // only ever positioned by a one-time initial-load resize handler, never
    // by the onPlayers callback that actually created it.
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/every time this\s+fires,\s+not just once at page load/i);
  });
});

describe("MULTIPLAYER_PROMPT_SECTION — reliable win/game-over", () => {
  it("requires an explicit broadcast game-over event, not a silent local-only computation", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/gameOver/);
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/never let\s+it be a purely local computation/i);
  });

  it("requires one shared result-rendering function for both the local-detection and incoming-message paths", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/one shared/i);
  });
});

describe("MULTIPLAYER_PROMPT_SECTION — solid player collision", () => {
  it("teaches push-apart collision resolution when players physically overlap, instead of passing through each other", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/push your position apart/i);
  });
});

describe("MULTIPLAYER_PROMPT_SECTION — smooth continuous state (latency compensation)", () => {
  // No lag compensation existed anywhere before this — broadcast()/onMessage()
  // applied whatever arrived instantly, which stutters/rubber-bands under
  // real latency. broadcastState()/getPeerState() give the SDK's own
  // interpolation a chance to smooth it, but only if the model is actually
  // taught to use them for continuously-changing values.
  it("teaches broadcastState()/getPeerState() for continuous values, distinct from broadcast()/onMessage()'s discrete events", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("Ariantra.broadcastState(");
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("Ariantra.getPeerState(");
  });

  it("explains WHY: broadcast()/onMessage() for continuous movement visibly stutters under real latency", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/stutter/i);
  });
});

// Owner UAT 2026-07-18: "host a game should last not for one race. it should
// allow multiple game restart." Generated games wire "play again" to
// location.reload() by default — a reload tears down the WebSocket session,
// so every rematch meant re-hosting and re-sharing the invite link. The
// contract must make one room host MANY rounds.
describe("MULTIPLAYER_PROMPT_SECTION — rematch without reload (one room, many rounds)", () => {
  it("forbids reloading the page to restart", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/never\s+(reload|use\s+location\.reload)/i);
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("location.reload()");
  });

  it("requires a broadcast restart event applied through one shared reset function", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/['"]restart['"]/);
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/same shared (reset|function)/i);
  });

  it("says the session/room outlives a single round", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/many rounds|round after round|stays? connected/i);
  });
});

// Owner UAT 2026-07-18 (second race): after a rematch, player 2's screen went
// solid blue while player 1 saw both cars — the restart reset scores but not
// player 2's own spawn/camera, because spawn layout lived only in the
// onPlayers handler and onPlayers does NOT re-fire on restart (roster
// unchanged). The contract must say so explicitly.
describe("MULTIPLAYER_PROMPT_SECTION — restart re-derives spawn/camera (onPlayers won't re-fire)", () => {
  it("warns that onPlayers does not fire again on restart", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/onPlayers\`? does NOT fire again/i);
  });

  it("requires the reset to re-derive every player's spawn AND the camera from the current roster", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/re-derive EVERY player's[\s\S]{0,40}spawn/i);
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/spawn position and the camera/i);
  });
});

// Owner UAT 2026-07-19 (platform BUG_LOG #35): an edit turn hallucinated an
// "Inline Polyfill for Ariantra Multiplayer" — `window.Ariantra = (…)` with a
// local-only stub — into the game body. It shipped, silently replacing the
// real SDK: the lobby still worked (the overlay captures its SDK reference in
// <head> before the clobber), but the game talked to the stub, so both
// players raced alone. Nothing in the prompt said the SDK always exists.
describe("MULTIPLAYER_PROMPT_SECTION — never stub or reassign the SDK (BUG_LOG #35)", () => {
  it("forbids polyfilling/stubbing/reassigning window.Ariantra", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/NEVER\s+(write|add)?\s*a?\s*(polyfill|stub|mock|fallback)/i);
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("window.Ariantra");
  });

  it("says the real SDK is always loaded before the game code runs", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/always\s+(exists|loaded)/i);
  });
});

// Owner UAT 2026-07-18 (third race, code inspected): both players spawned at
// the IDENTICAL hardcoded point, and the push-apart collision divides by the
// distance — two stacked cars → d === 0 → 0/0 = NaN position → camera lerps
// to NaN → solid sky-blue screen for the stationary player. Two contract
// gaps: no distinct-spawn rule, no zero-distance guard.
describe("MULTIPLAYER_PROMPT_SECTION — distinct spawns + zero-distance collision guard", () => {
  it("requires a DIFFERENT starting slot per player, never identical coordinates", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/DIFFERENT starting\s+(slot|position)/);
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/never[\s\S]{0,60}(same|identical)\s+(spot|coordinates|position)/i);
  });

  it("warns the push-apart division needs a zero-distance guard (NaN)", () => {
    expect(MULTIPLAYER_PROMPT_SECTION).toMatch(/distance is (exactly )?zero/i);
    expect(MULTIPLAYER_PROMPT_SECTION).toContain("NaN");
  });
});
