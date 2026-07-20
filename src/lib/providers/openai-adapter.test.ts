// Pins the OpenAI error taxonomy (owner decision 2026-07-20, cross-provider
// fallback). This is NOT a copy of the Gemini classifier: OpenAI overloads a
// single status code with opposite meanings, and getting it wrong either burns
// the chain on an unfixable billing error or dead-ends a recoverable outage.
import { describe, expect, it } from "vitest";
import { openaiAdapter } from "./openai-adapter";

/** OpenAI SDK errors carry status/code/type; raw network errors don't. */
const apiErr = (status: number, code?: string, message = "") =>
  Object.assign(new Error(message || code || String(status)), { status, code });

const plain = (m: string) => new Error(m);

describe("openaiAdapter.isConfigured", () => {
  it("O.1 true only with a non-empty OPENAI_API_KEY", () => {
    expect(openaiAdapter.isConfigured({ OPENAI_API_KEY: "sk-x" })).toBe(true);
    expect(openaiAdapter.isConfigured({ OPENAI_API_KEY: "" })).toBe(false);
    expect(openaiAdapter.isConfigured({})).toBe(false);
  });
});

describe("openaiAdapter.shouldTryNextModel — capacity vs defect", () => {
  it("O.2 429 rate_limit_exceeded is capacity → next model", () => {
    expect(openaiAdapter.shouldTryNextModel(apiErr(429, "rate_limit_exceeded"))).toBe(true);
  });

  // THE distinction that makes this adapter different from the Gemini one.
  // Both are 429. Walking the chain on insufficient_quota burns every model in
  // the chain against a wall that a different model cannot possibly clear, and
  // hides a billing failure behind a slow kid-facing timeout.
  it("O.3 429 insufficient_quota is a BILLING defect → throw, never walk the chain", () => {
    expect(openaiAdapter.shouldTryNextModel(apiErr(429, "insufficient_quota"))).toBe(false);
    expect(openaiAdapter.shouldTryNextModel(plain("429 You exceeded your current quota, please check your plan and billing details"))).toBe(false);
  });

  it("O.4 transient 5xx (500/502/503/504) → next model", () => {
    for (const s of [500, 502, 503, 504]) {
      expect(openaiAdapter.shouldTryNextModel(apiErr(s, "server_error")), String(s)).toBe(true);
    }
  });

  it("O.5 retired/unknown model id (404 model_not_found) → next model, never a dead prod", () => {
    expect(openaiAdapter.shouldTryNextModel(apiErr(404, "model_not_found"))).toBe(true);
    expect(openaiAdapter.shouldTryNextModel(plain("404 The model `gpt-4.1-nano` does not exist"))).toBe(true);
  });

  it("O.6 auth/permission/request defects → throw immediately", () => {
    expect(openaiAdapter.shouldTryNextModel(apiErr(401, "invalid_api_key"))).toBe(false);
    expect(openaiAdapter.shouldTryNextModel(apiErr(403, "permission_denied"))).toBe(false);
    expect(openaiAdapter.shouldTryNextModel(apiErr(400, "invalid_request_error"))).toBe(false);
  });

  // PRD-MODEL-FALLBACK §3.6: a safety block is a VERDICT, not an outage.
  // Retrying it on another model is shopping for a provider that says yes.
  it("O.7 content-filter refusals → throw, never retried on another model", () => {
    expect(openaiAdapter.shouldTryNextModel(apiErr(400, "content_filter"))).toBe(false);
    expect(openaiAdapter.shouldTryNextModel(plain("The response was filtered due to the prompt triggering our content management policy"))).toBe(false);
  });

  it("O.8 network-level drops → next model, matching the Gemini classifier", () => {
    for (const m of ["fetch failed", "read ECONNRESET", "socket hang up", "terminated", "ETIMEDOUT"]) {
      expect(openaiAdapter.shouldTryNextModel(plain(m)), m).toBe(true);
    }
  });

  it("O.9 an unrecognised error is NOT retried — fallback must never mask a real defect", () => {
    expect(openaiAdapter.shouldTryNextModel(plain("something entirely unexpected"))).toBe(false);
    expect(openaiAdapter.shouldTryNextModel(undefined)).toBe(false);
    expect(openaiAdapter.shouldTryNextModel(null)).toBe(false);
  });
});
