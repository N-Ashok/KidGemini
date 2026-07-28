// When Ari offers a stuck kid a human (docs/PRD-COMMUNITY-HELP.md §3.2).
// The nudge is the change most likely to spike ticket volume onto one admin, so
// its truth table is pinned here: it must never fire on a healthy game, and
// never more than once per generation.
import { describe, it, expect } from "vitest";
import {
  ASKS_BEFORE_OFFER,
  ASK_WINDOW_MS,
  FAILED_REPAIRS_BEFORE_OFFER,
  shouldOfferHelp,
  type StuckState,
} from "./stuck-signal";
import { MAX_REPAIR_ATTEMPTS } from "./verify-policy";

const NOW = 1_800_000_000_000;

const healthy = (over: Partial<StuckState> = {}): StuckState => ({
  generationId: "gen-1",
  failedRepairs: 0,
  verifyFailed: false,
  asksWithoutSwap: [],
  nudgedGenerationId: null,
  now: NOW,
  ...over,
});

describe("shouldOfferHelp — never on a healthy game", () => {
  it("K.1 a game that verified clean, with no repeated asks, gets no nudge", () => {
    expect(shouldOfferHelp(healthy())).toBe(false);
  });

  it("K.2 a failed verify ALONE doesn't nudge — the repair loop owns that first", () => {
    expect(shouldOfferHelp(healthy({ verifyFailed: true }))).toBe(false);
  });

  it("K.3 nothing on screen yet (no generation) never nudges", () => {
    expect(shouldOfferHelp(healthy({ generationId: null, failedRepairs: 5 }))).toBe(false);
  });

  it("K.4 one failed repair is not yet enough", () => {
    expect(shouldOfferHelp(healthy({ failedRepairs: 1, verifyFailed: true }))).toBe(false);
  });
});

describe("shouldOfferHelp — the two signals that do fire", () => {
  it("K.5 fires once the repair loop has spent its attempts and still failed", () => {
    expect(
      shouldOfferHelp(healthy({ failedRepairs: FAILED_REPAIRS_BEFORE_OFFER, verifyFailed: true })),
    ).toBe(true);
  });

  it("K.6 fires on three asks inside the window with no new game to show for them", () => {
    const asks = [NOW - 4 * 60_000, NOW - 2 * 60_000, NOW - 30_000];
    expect(asks).toHaveLength(ASKS_BEFORE_OFFER);
    expect(shouldOfferHelp(healthy({ asksWithoutSwap: asks }))).toBe(true);
  });

  it("K.7 asks spread outside the window don't count — that's a kid taking their time, not stuck", () => {
    const asks = [NOW - ASK_WINDOW_MS - 60_000, NOW - ASK_WINDOW_MS - 30_000, NOW - 30_000];
    expect(shouldOfferHelp(healthy({ asksWithoutSwap: asks }))).toBe(false);
  });

  it("K.8 asks that DID produce a new game are not in the list, so they never nudge", () => {
    // The caller only records asks with no artifact swap; two stale entries plus
    // a successful build in between stays below the threshold.
    expect(shouldOfferHelp(healthy({ asksWithoutSwap: [NOW - 60_000, NOW - 30_000] }))).toBe(false);
  });
});

describe("shouldOfferHelp — at most once per generation", () => {
  it("K.9 the same generation is never nudged twice", () => {
    const stuck = healthy({ failedRepairs: FAILED_REPAIRS_BEFORE_OFFER, verifyFailed: true });
    expect(shouldOfferHelp(stuck)).toBe(true);
    expect(shouldOfferHelp({ ...stuck, nudgedGenerationId: "gen-1" })).toBe(false);
  });

  it("K.10 a NEW generation that goes wrong may nudge again", () => {
    const stuck = healthy({
      generationId: "gen-2",
      failedRepairs: FAILED_REPAIRS_BEFORE_OFFER,
      verifyFailed: true,
      nudgedGenerationId: "gen-1",
    });
    expect(shouldOfferHelp(stuck)).toBe(true);
  });
});

describe("the machine gets first refusal (PRD §3.1)", () => {
  it("K.11 the nudge threshold IS the repair loop's own cap, so no ticket can pre-empt it", () => {
    // §3.1 is satisfied structurally: the self-healing loop runs automatically
    // and spends MAX_REPAIR_ATTEMPTS before a kid can tap 🆘, so tying the
    // threshold to that constant is what keeps "every ticket is something
    // automation couldn't handle" true.
    expect(FAILED_REPAIRS_BEFORE_OFFER).toBe(MAX_REPAIR_ATTEMPTS);
  });

  it("K.12 a failure with repairs still available never nudges", () => {
    for (let spent = 0; spent < MAX_REPAIR_ATTEMPTS; spent++) {
      expect(shouldOfferHelp(healthy({ verifyFailed: true, failedRepairs: spent })), `spent=${spent}`).toBe(
        false,
      );
    }
  });
});
