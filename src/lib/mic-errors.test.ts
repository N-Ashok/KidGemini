import { describe, it, expect } from "vitest";
import { micErrorMessage } from "./mic-errors";

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
