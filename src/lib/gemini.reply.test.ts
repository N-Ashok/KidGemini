// GeminiChatModel.reply()'s forceFullRegen override (used by api/chat/route.ts's
// patch-fallback path, BUG-FIX-LOG class fix 2026-07-18) and its real billed
// usage — needed so the fallback's extra Gemini call is cost-tracked, same as
// repair() already does.

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
import { GAME_EDIT_PROMPT_SECTION } from "./game-edit";

const historyWithGame = [
  { id: "1", role: "child" as const, text: "make me a racing game", createdAt: 1 },
  {
    id: "2", role: "assistant" as const,
    text: "Here!\n```html\n<!doctype html><html><body>GAME</body></html>\n```",
    artifactHtml: "<!doctype html><html><body>GAME</body></html>",
    createdAt: 2,
  },
];

describe("GeminiChatModel.reply — forceFullRegen bypasses the edit-patch instruction", () => {
  beforeEach(() => {
    generateContent.mockReset();
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "gemini-3-flash-preview";
  });

  it("without forceFullRegen, an edit turn still gets the edit section", async () => {
    generateContent.mockResolvedValue({ text: "```html<html></html>```" });
    const model = new GeminiChatModel();
    await model.reply({ history: historyWithGame, message: "make the car faster" });
    const call = generateContent.mock.calls[0]![0] as { config: { systemInstruction: string } };
    expect(call.config.systemInstruction).toContain(GAME_EDIT_PROMPT_SECTION);
  });

  it("forceFullRegen:true drops the edit section even though a game already exists", async () => {
    generateContent.mockResolvedValue({ text: "```html<html></html>```" });
    const model = new GeminiChatModel();
    await model.reply({ history: historyWithGame, message: "make the car faster", forceFullRegen: true });
    const call = generateContent.mock.calls[0]![0] as { config: { systemInstruction: string } };
    expect(call.config.systemInstruction).not.toContain(GAME_EDIT_PROMPT_SECTION);
  });

  it("returns the real billed usage when Gemini reports it (cost tracking for the fallback call)", async () => {
    generateContent.mockResolvedValue({
      text: "hi",
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 0 },
    });
    const model = new GeminiChatModel();
    const out = await model.reply({ history: [], message: "hello" });
    expect(out.usage).toEqual({ promptTokens: 100, outputTokens: 20, thoughtTokens: 5, cachedTokens: 0 });
  });

  it("no usageMetadata → usage is undefined (route falls back to char estimates)", async () => {
    generateContent.mockResolvedValue({ text: "hi" });
    const model = new GeminiChatModel();
    const out = await model.reply({ history: [], message: "hello" });
    expect(out.usage).toBeUndefined();
  });
});
