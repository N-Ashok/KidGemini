// Regression test for BUG-FIX-LOG 2026-07-18: reply() and repair() used to
// call `this.model` directly with NO fallback chain, unlike replyStream() —
// so a retired/misconfigured model id (or a transient Google outage) that
// the main streamed answer recovers from just fine would hard-fail the
// "patch didn't match → full regeneration" safety net AND self-healing
// repair, producing the exact dead-end "Oops! Something went wrong." these
// paths exist to prevent. Written against a live incident: GEMINI_CHAT_MODEL
// misconfigured (missing the leading "g") — replyStream() recovered via its
// fallback chain, but reply()'s forceFullRegen fallback and repair() both
// 404'd outright with nothing to catch it.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const generateContent = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: (...a: unknown[]) => generateContent(...a) };
  },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "h",
    HARM_CATEGORY_HATE_SPEECH: "hs",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "se",
    HARM_CATEGORY_DANGEROUS_CONTENT: "dc",
  },
  HarmBlockThreshold: { BLOCK_LOW_AND_ABOVE: "low", BLOCK_MEDIUM_AND_ABOVE: "med" },
}));

vi.mock("./retry", () => ({
  withRetry: (fn: () => unknown) => fn(),
  withTimeout: (fn: () => unknown) => fn(),
}));

import { GeminiChatModel } from "./gemini";

const goneErr = () =>
  new Error(
    '404 NOT_FOUND: {"error":{"code":404,"message":"models/emini-3-flash-preview is not found for API version v1beta, or is not supported for generateContent.","status":"NOT_FOUND"}}',
  );

const calledModels = () => generateContent.mock.calls.map((c) => (c[0] as { model: string }).model);

beforeEach(() => {
  generateContent.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
  // Reproduces the live incident: a misconfigured primary outside the
  // default chain, so all 3 default fallbacks apply.
  process.env.GEMINI_CHAT_MODEL = "emini-3-flash-preview";
});

describe("GeminiChatModel.reply — falls back like replyStream() (BUG-FIX-LOG 2026-07-18)", () => {
  it("a 404/retired primary model id falls back to the next model instead of dead-ending", async () => {
    generateContent
      .mockRejectedValueOnce(goneErr())
      .mockResolvedValueOnce({ text: "```html<html>fixed</html>```" });

    const model = new GeminiChatModel();
    const out = await model.reply({ history: [], message: "add a jump", forceFullRegen: true });

    expect(out.artifactHtml).toContain("fixed");
    const models = calledModels();
    expect(models).toHaveLength(2);
    expect(models[1]).not.toBe(models[0]);
  });

  it("walks the whole chain and returns usage from whichever model actually served it", async () => {
    generateContent
      .mockRejectedValueOnce(goneErr())
      .mockResolvedValueOnce({
        text: "hi",
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0, cachedContentTokenCount: 0 },
      });

    const model = new GeminiChatModel();
    const out = await model.reply({ history: [], message: "hello" });

    expect(out.usage).toEqual({ promptTokens: 10, outputTokens: 5, thoughtTokens: 0, cachedTokens: 0 });
  });

  it("a genuine non-transient error still throws immediately — no fallback call burned", async () => {
    generateContent.mockRejectedValueOnce(new Error("400 INVALID_ARGUMENT: bad request"));

    const model = new GeminiChatModel();
    await expect(model.reply({ history: [], message: "hello" })).rejects.toThrow(/chat generation failed/);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("GeminiChatModel.repair — falls back like replyStream() (BUG-FIX-LOG 2026-07-18)", () => {
  it("a 404/retired primary model id falls back instead of losing the auto-heal", async () => {
    generateContent
      .mockRejectedValueOnce(goneErr())
      .mockResolvedValueOnce({ text: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE" });

    const model = new GeminiChatModel();
    const out = await model.repair({ systemPrompt: "fix it", prompt: "broken game" });

    expect(out.text).toContain("REPLACE");
    expect(calledModels()).toHaveLength(2);
  });

  it("a genuine non-transient error still throws immediately", async () => {
    generateContent.mockRejectedValueOnce(new Error("403 PERMISSION_DENIED: API key invalid"));

    const model = new GeminiChatModel();
    await expect(model.repair({ systemPrompt: "fix it", prompt: "broken game" })).rejects.toThrow(/repair generation failed/);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});
