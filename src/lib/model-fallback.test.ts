// Pins the 4-model fallback chain policy (PRD-MODEL-FALLBACK §2/§3).
import { describe, expect, it } from "vitest";
import { fallbackChain, isModelGone, isOverloaded, MAX_FALLBACKS, shouldTryNextModel } from "./model-fallback";

describe("fallbackChain", () => {
  it("default chain is the owner-specified ladder (2026-07-11): 3-flash-preview → 2.5-flash → 2.5-flash-lite", () => {
    expect(fallbackChain("gemini-3.5-flash", {})).toEqual([
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });

  it("never includes the primary — that would re-enter the same overloaded pool", () => {
    const chain = fallbackChain("gemini-2.5-flash", {});
    expect(chain).not.toContain("gemini-2.5-flash");
    expect(chain).toEqual(["gemini-3-flash-preview", "gemini-2.5-flash-lite"]);
  });

  it("env GEMINI_FALLBACK_MODELS overrides, trimmed, deduped, capped at 4", () => {
    const chain = fallbackChain("p", {
      GEMINI_FALLBACK_MODELS: " a , b ,b, c , d , e ",
    });
    expect(chain).toEqual(["a", "b", "c", "d"]);
    expect(chain.length).toBeLessThanOrEqual(MAX_FALLBACKS);
  });

  it("legacy single GEMINI_FALLBACK_MODEL still works (Phase 1 deployments)", () => {
    expect(fallbackChain("p", { GEMINI_FALLBACK_MODEL: "gemini-2.5-flash" })).toEqual(["gemini-2.5-flash"]);
  });
});

describe("chain policy — what moves down the chain vs throws", () => {
  const err = (m: string) => new Error(m);

  it("capacity errors (503/UNAVAILABLE/high demand/429) → next model", () => {
    expect(shouldTryNextModel(err('got status: UNAVAILABLE. {"code":503,"message":"high demand"}'))).toBe(true);
    expect(shouldTryNextModel(err("429 RESOURCE_EXHAUSTED: quota exceeded"))).toBe(true);
    expect(isOverloaded(err("The model is overloaded. Please try again later."))).toBe(true);
  });

  it("retired model ids (404/NOT_FOUND) → next model, never a dead prod", () => {
    expect(shouldTryNextModel(err("404 NOT_FOUND: models/gemini-2.0-flash is not found"))).toBe(true);
    expect(isModelGone(err("model gemini-2.0-flash is not supported"))).toBe(true);
  });

  it("safety/auth/request defects throw immediately — fallback never masks them", () => {
    expect(shouldTryNextModel(err("400 INVALID_ARGUMENT: bad request"))).toBe(false);
    expect(shouldTryNextModel(err("403 PERMISSION_DENIED: API key invalid"))).toBe(false);
    expect(shouldTryNextModel(err("blocked by safety settings"))).toBe(false);
  });
});
