// Regression (BUG-FIX-LOG 2026-07-13): the primary model wasn't in
// MODEL_PRICING, so estimateCostUsd returned 0 and the admin dashboard
// reported $0 while real Gemini billing accrued. Unknown models must now
// fail VISIBLE (conservative fallback estimate), never silently $0.
import { describe, it, expect } from "vitest";
import { estimateCostUsd, MODEL_PRICING } from "./pricing.config";

describe("estimateCostUsd", () => {
  it("every model in the production chain has an explicit price", () => {
    for (const model of ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"]) {
      expect(MODEL_PRICING[model], `${model} missing from MODEL_PRICING`).toBeDefined();
    }
  });

  it("a known model prices by its table entry", () => {
    const usd = estimateCostUsd("gemini-2.5-flash", 1_000_000, 1_000_000);
    expect(usd).toBeCloseTo(0.3 + 2.5, 5);
  });

  it("an UNKNOWN model never estimates $0 — conservative fallback instead", () => {
    const usd = estimateCostUsd("gemini-99-ultra", 1_000_000, 1_000_000);
    expect(usd).toBeGreaterThan(0);
  });

  it("zero tokens cost zero regardless of model", () => {
    expect(estimateCostUsd("gemini-99-ultra", 0, 0)).toBe(0);
  });
});
