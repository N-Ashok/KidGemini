import { describe, it, expect } from "vitest";
import { isFatalMicError } from "./mic-errors";

// micErrorMessage's per-code copy moved to mic-recovery.ts as device-aware
// cards (BUG-FIX-LOG 2026-07-20 "laptop told to fix Siri") — its coverage
// lives in mic-recovery.test.ts now.

/** Regression (mic auto-close): while the kid is still talking, pauses fire
 *  "no-speech"/"aborted" and the session ends — those must auto-restart, not
 *  stop the mic. Only errors the kid must fix (permission, hardware, network)
 *  may end the listening session. */
describe("isFatalMicError", () => {
  it("permission / hardware / network errors end the session", () => {
    expect(isFatalMicError("not-allowed")).toBe(true);
    expect(isFatalMicError("service-not-allowed")).toBe(true);
    expect(isFatalMicError("audio-capture")).toBe(true);
    expect(isFatalMicError("network")).toBe(true);
  });
  it("pauses in speech keep the mic alive", () => {
    expect(isFatalMicError("no-speech")).toBe(false);
    expect(isFatalMicError("aborted")).toBe(false);
    expect(isFatalMicError("")).toBe(false);
  });
});
