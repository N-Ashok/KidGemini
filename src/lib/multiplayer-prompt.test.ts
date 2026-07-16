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
