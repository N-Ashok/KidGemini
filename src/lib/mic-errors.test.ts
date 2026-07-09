import { describe, it, expect } from "vitest";
import { isFatalMicError, micErrorMessage } from "./mic-errors";

/** BUG-FIX-LOG 2026-07-07: mobile mic failures were swallowed silently —
 *  every SpeechRecognition error code must map to kid-friendly next steps. */
describe("micErrorMessage", () => {
  it("explains permission denial with the fix", () => {
    expect(micErrorMessage("not-allowed")).toMatch(/allow the microphone/i);
    expect(micErrorMessage("service-not-allowed")).toMatch(/dictation/i);
  });
  it("treats silence as a gentle retry", () => {
    expect(micErrorMessage("no-speech")).toMatch(/didn.t hear/i);
  });
  it("network + unknown codes still say something actionable", () => {
    expect(micErrorMessage("network")).toMatch(/internet/i);
    expect(micErrorMessage("weird-new-code")).toMatch(/try again/i);
  });
});

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
