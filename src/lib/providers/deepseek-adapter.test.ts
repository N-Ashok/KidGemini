// DeepSeek is OpenAI-API-compatible, so its adapter reuses the OpenAI taxonomy
// verbatim — this pins only what differs: identity (DEEPSEEK_API_KEY) and that
// the OpenAI-shaped decisions actually flow through.
import { describe, expect, it } from "vitest";
import { deepseekAdapter } from "./deepseek-adapter";

const err = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? "x")), fields);

describe("deepseekAdapter", () => {
  it("DA.1 isConfigured tracks DEEPSEEK_API_KEY (not the OpenAI or Moonshot key)", () => {
    expect(deepseekAdapter.isConfigured({ DEEPSEEK_API_KEY: "k" })).toBe(true);
    expect(deepseekAdapter.isConfigured({ OPENAI_API_KEY: "o", MOONSHOT_API_KEY: "m" })).toBe(false);
  });

  it("DA.2 provider id is deepseek", () => {
    expect(deepseekAdapter.provider).toBe("deepseek");
  });

  it("DA.3 inherits the OpenAI walk/throw decisions (429 walks, quota throws, 404 is gone)", () => {
    expect(deepseekAdapter.shouldTryNextModel(err({ status: 429, code: "rate_limit_exceeded" }))).toBe(true);
    expect(deepseekAdapter.shouldTryNextModel(err({ code: "insufficient_quota" }))).toBe(false);
    expect(deepseekAdapter.isModelGone(err({ status: 404, code: "model_not_found" }))).toBe(true);
  });
});
