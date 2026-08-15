// Mid-play self-heal policy (2026-08-15).
//
// Owner: "when there is an error the browser should automatically push to Ari
// and solve it. now more than ever, i see error reports [and broken games]."
// The auto-heal only ever covered the load window — the verify controller
// settles and then discards every console message, so a game that broke while
// the child was PLAYING reached nothing.
//
// These pin the guards, because the risk here is the opposite of the bug:
// this code REPLACES THE GAME A CHILD IS PLAYING, so every false positive is
// worse than the error it imagines it is fixing.
import { describe, it, expect } from "vitest";
import {
  shouldHealMidPlay,
  isBreakingError,
  breakingErrors,
  MAX_MIDPLAY_HEALS_PER_DOC,
  MIDPLAY_ARM_DELAY_MS,
  MIDPLAY_HEAL_WINDOW_MS,
} from "./midplay-heal";
import type { GameConsoleMessage } from "@/types/game-console.types";

const ok = {
  enabled: true,
  settled: true,
  busy: false,
  healsThisDoc: 0,
  msSinceSettle: MIDPLAY_ARM_DELAY_MS + 1_000,
  hardErrorCount: 1,
};

describe("shouldHealMidPlay", () => {
  it("heals a settled game that threw while being played", () => {
    expect(shouldHealMidPlay(ok)).toBe(true);
  });

  it("never fires while a turn is streaming", () => {
    // 2026-08-11: the proactive draw-call auto-fix sent a real turn mid-edit,
    // raced the artifact update and froze the preview on a blue screen. Every
    // passive trigger has to check this for itself.
    expect(shouldHealMidPlay({ ...ok, busy: true })).toBe(false);
  });

  it("never fires before verify has settled — that window has its own loop", () => {
    expect(shouldHealMidPlay({ ...ok, settled: false })).toBe(false);
  });

  it("never fires without a breaking error", () => {
    expect(shouldHealMidPlay({ ...ok, hardErrorCount: 0 })).toBe(false);
  });

  it("heals a document at most once", () => {
    expect(shouldHealMidPlay({ ...ok, healsThisDoc: MAX_MIDPLAY_HEALS_PER_DOC })).toBe(false);
  });

  it("waits for the arm delay, so it cannot race the load-time repair", () => {
    expect(shouldHealMidPlay({ ...ok, msSinceSettle: MIDPLAY_ARM_DELAY_MS - 1 })).toBe(false);
  });

  it("stops offering after the window closes", () => {
    // A child ten minutes into a game they are enjoying should not have it
    // swapped out from under them over a stray error.
    expect(shouldHealMidPlay({ ...ok, msSinceSettle: MIDPLAY_HEAL_WINDOW_MS + 1 })).toBe(false);
  });

  it("respects the repair kill switch", () => {
    expect(shouldHealMidPlay({ ...ok, enabled: false })).toBe(false);
  });
});

describe("isBreakingError", () => {
  const msg = (m: Partial<GameConsoleMessage>): GameConsoleMessage =>
    ({ level: "error", text: "boom", ...m }) as GameConsoleMessage;

  it("counts a thrown error and an unhandled rejection", () => {
    expect(isBreakingError(msg({ kind: "error" }))).toBe(true);
    expect(isBreakingError(msg({ kind: "rejection" }))).toBe(true);
  });

  it("does NOT count a plain console.error from a game that is still running", () => {
    // Deliberately stricter than error-report.ts's isHardError, which gates
    // merely SHOWING the console tab. A game that logs an error string and
    // keeps playing is working; replacing it would be a false repair.
    expect(isBreakingError(msg({}))).toBe(false);
  });

  it("does not count warnings or logs", () => {
    expect(isBreakingError(msg({ level: "warn", kind: "error" }))).toBe(false);
    expect(isBreakingError(msg({ level: "log" }))).toBe(false);
  });

  it("does not count a 404'd resource — that is the load path's code", () => {
    expect(isBreakingError(msg({ kind: "resource" }))).toBe(false);
  });

  it("breakingErrors keeps whole messages (stack included) and caps the list", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      msg({ kind: "error", text: `e${i}`, stack: "at foo" }),
    );
    const picked = breakingErrors([...many, msg({ level: "log", text: "chatter" })]);
    expect(picked).toHaveLength(20);
    expect(picked[0]!.stack).toBe("at foo"); // the stack is what makes a repair aimable
    expect(picked.at(-1)!.text).toBe("e29"); // newest kept
  });
});
