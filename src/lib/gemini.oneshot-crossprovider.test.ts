// E (2026-07-20): the one-shot paths (reply/repair/strictEditRetry) now cross
// providers, like the streaming path already does. Before this they filtered
// every non-Google id out of their chains, so a rescue could only ever be
// another Gemini model. Here a failed Google primary is rescued by an OpenAI
// slot dispatched to OpenAIGenerator.generateOnce (moderated) — not a 404.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const generateContent = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: (...a: unknown[]) => generateContent(...a) };
  },
  HarmCategory: { HARM_CATEGORY_HARASSMENT: "h", HARM_CATEGORY_HATE_SPEECH: "hs", HARM_CATEGORY_SEXUALLY_EXPLICIT: "se", HARM_CATEGORY_DANGEROUS_CONTENT: "dc" },
  HarmBlockThreshold: { BLOCK_LOW_AND_ABOVE: "low", BLOCK_MEDIUM_AND_ABOVE: "med" },
}));

vi.mock("./retry", () => ({ withRetry: (fn: () => unknown) => fn(), withTimeout: (fn: () => unknown) => fn() }));

// Fake OpenAI generator so the cross-provider dispatch is observable with no
// network. buildMessages/ModerationBlockedError are re-exported because
// moonshot-generation.ts imports buildMessages from this module.
const generateOnceMock = vi.fn();
vi.mock("./providers/openai-generation", () => ({
  OpenAIGenerator: class {
    generateOnce = (...a: unknown[]) => generateOnceMock(...a);
    openStream = vi.fn();
  },
  buildMessages: () => [],
  ModerationBlockedError: class extends Error {},
}));

import { GeminiChatModel } from "./gemini";

const transient = () => new Error('got status: UNAVAILABLE {"error":{"code":503,"status":"UNAVAILABLE"}}');

beforeEach(() => {
  generateContent.mockReset();
  generateOnceMock.mockReset();
  process.env.GEMINI_API_KEY = "g";
  process.env.OPENAI_API_KEY = "o";
  // Google primary, one explicit OpenAI backup — so the one-shot chain is
  // [gemini-3.5-flash, gpt-5.6-luna].
  process.env.GEMINI_CHAT_MODEL = "gemini-3.5-flash";
  process.env.MODEL_FALLBACK_CHAIN = "gpt-5.6-luna";
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.MODEL_FALLBACK_CHAIN;
});

describe("cross-provider one-shot (E)", () => {
  it("E.1 a failed Google primary is rescued by an OpenAI slot via generateOnce", async () => {
    generateContent.mockRejectedValueOnce(transient()); // Google primary down
    generateOnceMock.mockResolvedValueOnce({ text: "Rescued by OpenAI!", usage: { promptTokens: 3, outputTokens: 4, thoughtTokens: 0, cachedTokens: 0 } });

    const model = new GeminiChatModel();
    const out = await model.reply({ history: [], message: "hello" });

    expect(out.text).toBe("Rescued by OpenAI!");
    expect(generateOnceMock).toHaveBeenCalledTimes(1);
    // dispatched with the OpenAI model id + a provider-neutral GenerationRequest
    expect(generateOnceMock.mock.calls[0]![0]).toBe("gpt-5.6-luna");
    expect(generateOnceMock.mock.calls[0]![1]).toMatchObject({ message: "hello", systemInstruction: expect.any(String) });
  });

  it("E.2 repair() also crosses providers (self-heal isn't Google-only anymore)", async () => {
    generateContent.mockRejectedValueOnce(transient());
    generateOnceMock.mockResolvedValueOnce({ text: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE" });

    const model = new GeminiChatModel();
    const out = await model.repair({ systemPrompt: "fix it", prompt: "broken game" });

    expect(out.text).toContain("REPLACE");
    expect(generateOnceMock).toHaveBeenCalledTimes(1);
  });

  it("E.3 when Google succeeds first, no cross-provider call is made", async () => {
    generateContent.mockResolvedValueOnce({ text: "Google was fine!" });

    const model = new GeminiChatModel();
    const out = await model.reply({ history: [], message: "hello" });

    expect(out.text).toBe("Google was fine!");
    expect(generateOnceMock).not.toHaveBeenCalled();
  });
});
