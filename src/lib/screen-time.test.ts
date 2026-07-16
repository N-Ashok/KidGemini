// PRD-SCREEN-TIME-CAP-MVP Part B — the pure minute-derivation policy.
// No DB/React imports here on purpose: mirrors verify-policy.ts's shape so
// the tricky "how do we turn message timestamps into a minutes count" logic
// is testable without SQLite or a running server.
import { describe, it, expect } from "vitest";
import { GAP_CAP_MINUTES, TAIL_MINUTES, deriveActiveMinutes, utcDayStart } from "./screen-time";

describe("deriveActiveMinutes", () => {
  it("empty history → 0 minutes", () => {
    expect(deriveActiveMinutes([])).toBe(0);
  });

  it("a single event → just the tail allowance (still reading/playing after it)", () => {
    expect(deriveActiveMinutes([0])).toBe(TAIL_MINUTES);
  });

  it("consecutive close-together events sum their gaps plus the tail", () => {
    // 3 events, 1 minute apart each: 2 gaps of 1 min + 2 min tail = 4 min.
    expect(deriveActiveMinutes([0, 60_000, 120_000])).toBe(4);
  });

  it("a gap longer than GAP_CAP_MINUTES is capped, not counted in full", () => {
    // 30-minute gap between two events — capped at 5 min + 2 min tail = 7.
    expect(deriveActiveMinutes([0, 30 * 60_000])).toBe(GAP_CAP_MINUTES + TAIL_MINUTES);
  });

  it("an overnight gap doesn't inflate the tally beyond the cap — identical to any gap just over the cap", () => {
    const justOverCap = deriveActiveMinutes([0, (GAP_CAP_MINUTES + 1) * 60_000]);
    const eightHourGap = deriveActiveMinutes([0, 8 * 60 * 60_000]);
    expect(eightHourGap).toBe(justOverCap);
    expect(eightHourGap).toBe(GAP_CAP_MINUTES + TAIL_MINUTES);
  });

  it("timestamps are summed in the order given, so a caller must pass them ascending", () => {
    // Two 1-minute-apart events plus tail = 3 min, regardless of extra precision.
    expect(deriveActiveMinutes([1_000, 61_000])).toBe(1 + TAIL_MINUTES);
  });
});

describe("utcDayStart", () => {
  it("snaps a midday timestamp to UTC midnight of the same day", () => {
    const midday = Date.UTC(2026, 6, 15, 15, 30, 0);
    expect(utcDayStart(midday)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });

  it("just after midnight stays on the same day", () => {
    const justAfter = Date.UTC(2026, 6, 15, 0, 0, 1);
    expect(utcDayStart(justAfter)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });

  it("just before midnight stays on the same day (doesn't roll to the next one)", () => {
    const justBefore = Date.UTC(2026, 6, 15, 23, 59, 59);
    expect(utcDayStart(justBefore)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });
});
