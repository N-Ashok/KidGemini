// The guest gate's tunables (2026-08-16).
//
// WHY THIS FILE EXISTS NOW: `IP_GUEST_TOKEN_CAP` became env-overridable so the
// golden-prompt harness can finish a local run. That cap is a PAYWALL — the
// backstop that stops serial-incognito from resetting the free trial — so the
// override needs the same care as the gate itself: a missing, empty, junk,
// zero, or negative value must fall back to the shipped 20,000, never to
// "unlimited". Getting that wrong gives the app away.
//
// It follows the pattern already in this file (`guestTokenLimitFor` /
// `BIBLE_TEACHER_GUEST_TOKEN_LIMIT`): a tunable, not a bypass. The gate still
// runs, still counts, still walls — only the number moves, and only where the
// variable is set.
import { describe, it, expect } from "vitest";
import { ipGuestTokenCap, IP_GUEST_TOKEN_CAP, guestTokenLimitFor } from "./gate.config";

describe("ipGuestTokenCap — the per-IP guest backstop", () => {
  it("is 20,000 when nothing is set — production's shipped value", () => {
    expect(ipGuestTokenCap({})).toBe(IP_GUEST_TOKEN_CAP);
    expect(IP_GUEST_TOKEN_CAP).toBe(20_000);
  });

  it("honours a valid override", () => {
    expect(ipGuestTokenCap({ IP_GUEST_TOKEN_CAP: "5000000" })).toBe(5_000_000);
  });

  it("can be tightened as well as loosened — this is a dial, not a switch", () => {
    expect(ipGuestTokenCap({ IP_GUEST_TOKEN_CAP: "1000" })).toBe(1_000);
  });

  // Every one of these must fall back to the shipped cap. A paywall that fails
  // OPEN on a typo is worse than one that cannot be tuned at all.
  for (const [label, value] of [
    ["empty string", ""],
    ["whitespace", "   "],
    ["not a number", "lots"],
    ["zero", "0"],
    ["negative", "-1"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["a number with junk", "20000; DROP"],
  ] as const) {
    it(`falls back to the shipped cap on ${label}`, () => {
      expect(ipGuestTokenCap({ IP_GUEST_TOKEN_CAP: value })).toBe(IP_GUEST_TOKEN_CAP);
    });
  }

  it("reads the environment per call, so ops can change it without a rebuild", () => {
    const env: Record<string, string | undefined> = {};
    expect(ipGuestTokenCap(env)).toBe(IP_GUEST_TOKEN_CAP);
    env.IP_GUEST_TOKEN_CAP = "999999";
    expect(ipGuestTokenCap(env)).toBe(999_999);
  });

  it("defaults to process.env when no env is passed", () => {
    // The call shape the route uses. With the variable unset in the test
    // process this must be the shipped value.
    expect(ipGuestTokenCap()).toBe(
      process.env.IP_GUEST_TOKEN_CAP ? ipGuestTokenCap(process.env) : IP_GUEST_TOKEN_CAP,
    );
  });
});

describe("the neighbouring tunables are unchanged", () => {
  it("the device token allowance is still 10,000 and not env-tunable", () => {
    expect(guestTokenLimitFor(undefined, { GUEST_TOKEN_LIMIT: "999999" })).toBe(10_000);
  });

  it("the bible-teacher trial keeps its own override", () => {
    expect(guestTokenLimitFor("bible-teacher", {})).toBe(2_000);
    expect(guestTokenLimitFor("bible-teacher", { BIBLE_TEACHER_GUEST_TOKEN_LIMIT: "500" })).toBe(500);
  });
});
