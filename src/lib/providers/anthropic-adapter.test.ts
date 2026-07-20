// Anthropic error taxonomy: capacity (429/529), retired ids and transient infra
// walk the chain; refusals, auth and 400s throw. Same contract as the OpenAI
// adapter, different status codes (Anthropic's dedicated 529 "overloaded").
import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "./anthropic-adapter";

const err = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? "x")), fields);

describe("anthropicAdapter", () => {
  it("AN.1 isConfigured tracks ANTHROPIC_API_KEY", () => {
    expect(anthropicAdapter.isConfigured({ ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(anthropicAdapter.isConfigured({})).toBe(false);
  });

  it("AN.2 429 rate limit and 529 overloaded both WALK the chain", () => {
    expect(anthropicAdapter.shouldTryNextModel(err({ status: 429 }))).toBe(true);
    expect(anthropicAdapter.shouldTryNextModel(err({ status: 529, errorType: "overloaded_error" }))).toBe(true);
  });

  it("AN.3 transient 5xx walks; a 404 is 'model gone' (walks AND is flagged)", () => {
    expect(anthropicAdapter.shouldTryNextModel(err({ status: 503 }))).toBe(true);
    expect(anthropicAdapter.shouldTryNextModel(err({ status: 404, errorType: "not_found_error" }))).toBe(true);
    expect(anthropicAdapter.isModelGone(err({ status: 404 }))).toBe(true);
    expect(anthropicAdapter.isModelGone(err({ status: 503 }))).toBe(false);
  });

  it("AN.4 auth (401/403) and 400s THROW — never walk", () => {
    expect(anthropicAdapter.shouldTryNextModel(err({ status: 401 }))).toBe(false);
    expect(anthropicAdapter.shouldTryNextModel(err({ status: 400, errorType: "invalid_request_error" }))).toBe(false);
  });

  it("AN.5 a content/safety refusal fails closed (never walks to shop a yes)", () => {
    expect(anthropicAdapter.shouldTryNextModel(err({ errorType: "permission_error", message: "content policy" }))).toBe(false);
  });

  it("AN.6 an unknown failure returns false — a real defect must not be laundered across models", () => {
    expect(anthropicAdapter.shouldTryNextModel(err({ message: "totally unexpected" }))).toBe(false);
  });
});
