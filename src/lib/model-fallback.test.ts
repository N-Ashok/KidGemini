// Pins the 4-model fallback chain policy (PRD-MODEL-FALLBACK §2/§3).
import { describe, expect, it } from "vitest";
import { fallbackChain, isModelGone, isOverloaded, isTransient, MAX_FALLBACKS, shouldTryNextModel } from "./model-fallback";

describe("fallbackChain", () => {
  it("default chain is the owner-specified ladder (2026-07-13, cost-aware): 2.5-flash → 3.5-flash → 2.5-flash-lite", () => {
    expect(fallbackChain("gemini-3-flash-preview", {})).toEqual([
      "gemini-2.5-flash",
      "gemini-3.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });

  it("never includes the primary — that would re-enter the same overloaded pool", () => {
    const chain = fallbackChain("gemini-2.5-flash", {});
    expect(chain).not.toContain("gemini-2.5-flash");
    expect(chain).toEqual(["gemini-3.5-flash", "gemini-2.5-flash-lite"]);
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

  // Regression 2026-07-13: production "Oops! Something went wrong." with NO
  // fallback — Google returned a transient 5xx that wasn't 503, so
  // shouldTryNextModel said throw. The retry layer already treated
  // 500/502/504/network drops as transient; the chain must agree.
  it("transient 5xx (500 INTERNAL/502/504) → next model, matching the retry layer", () => {
    expect(shouldTryNextModel(err('got status: INTERNAL. {"code":500,"message":"An internal error has occurred."}'))).toBe(true);
    expect(shouldTryNextModel(err("502 Bad Gateway"))).toBe(true);
    expect(shouldTryNextModel(err("504 Gateway Timeout"))).toBe(true);
    expect(isTransient(err("500 Internal Server Error"))).toBe(true);
  });

  it("network-level drops (fetch failed/ECONNRESET/socket hang up/terminated) → next model", () => {
    expect(shouldTryNextModel(err("fetch failed"))).toBe(true);
    expect(shouldTryNextModel(err("read ECONNRESET"))).toBe(true);
    expect(shouldTryNextModel(err("socket hang up"))).toBe(true);
    expect(shouldTryNextModel(err("terminated"))).toBe(true);
    expect(shouldTryNextModel(err("Client network socket disconnected before secure TLS connection was established"))).toBe(true);
  });

  it("transient detection stays out of caller-defect messages", () => {
    expect(isTransient(err("400 INVALID_ARGUMENT: bad request"))).toBe(false);
    expect(isTransient(err("403 PERMISSION_DENIED: API key invalid"))).toBe(false);
    expect(isTransient(err("blocked by safety settings"))).toBe(false);
  });
});
