// Moonshot is OpenAI-API-compatible, so its adapter reuses the OpenAI taxonomy
// verbatim — this pins only what differs: identity (MOONSHOT_API_KEY) and that
// the OpenAI-shaped decisions actually flow through.
import { describe, expect, it } from "vitest";
import { moonshotAdapter } from "./moonshot-adapter";

const err = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? "x")), fields);

describe("moonshotAdapter", () => {
  it("MA.1 isConfigured tracks MOONSHOT_API_KEY (not the OpenAI key)", () => {
    expect(moonshotAdapter.isConfigured({ MOONSHOT_API_KEY: "k" })).toBe(true);
    expect(moonshotAdapter.isConfigured({ OPENAI_API_KEY: "o" })).toBe(false);
  });

  it("MA.2 provider id is moonshot", () => {
    expect(moonshotAdapter.provider).toBe("moonshot");
  });

  it("MA.3 inherits the OpenAI walk/throw decisions (429 walks, quota throws, 404 is gone)", () => {
    expect(moonshotAdapter.shouldTryNextModel(err({ status: 429, code: "rate_limit_exceeded" }))).toBe(true);
    expect(moonshotAdapter.shouldTryNextModel(err({ code: "insufficient_quota" }))).toBe(false);
    expect(moonshotAdapter.isModelGone(err({ status: 404, code: "model_not_found" }))).toBe(true);
  });
});
