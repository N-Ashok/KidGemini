// replyStream must surface Gemini's REAL billed token counts (usageMetadata:
// prompt / output / thinking / cached) as a final `usage` chunk so the cost
// dashboard records what Google actually bills, not a char/4 estimate
// (2026-07-14). Streams without usageMetadata emit no usage chunk (fallback
// to estimates stays in the route).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const generateContentStream = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContentStream: (...a: unknown[]) => generateContentStream(...a) };
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
import type { StreamChunk } from "@/types/chat.types";

async function collect(model: GeminiChatModel): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of model.replyStream({ history: [], message: "make me a game" })) out.push(c);
  return out;
}

beforeEach(() => {
  generateContentStream.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_CHAT_MODEL = "gemini-3-flash-preview";
});

describe("GeminiChatModel.replyStream — usage chunk", () => {
  it("U.1 yields one final usage chunk with all 4 counts (last usageMetadata wins)", async () => {
    generateContentStream.mockResolvedValueOnce(
      (async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: "Hello" }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 },
        };
        yield {
          candidates: [{ content: { parts: [{ text: " world" }] } }],
          usageMetadata: {
            promptTokenCount: 100, candidatesTokenCount: 12,
            thoughtsTokenCount: 7, cachedContentTokenCount: 20,
          },
        };
      })(),
    );

    const out = await collect(new GeminiChatModel());
    expect(out).toEqual([
      { kind: "delta", text: "Hello" },
      { kind: "delta", text: " world" },
      {
        kind: "usage", text: "", model: "gemini-3-flash-preview",
        usage: { promptTokens: 100, outputTokens: 12, thoughtTokens: 7, cachedTokens: 20 },
      },
    ]);
  });

  it("U.1b the usage chunk names the model that ACTUALLY served (fallback ≠ primary)", async () => {
    const overloadErr = new Error(
      'got status: UNAVAILABLE. {"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}',
    );
    generateContentStream
      .mockRejectedValueOnce(overloadErr)
      .mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [{ content: { parts: [{ text: "hi" }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
          };
        })(),
      );

    const out = await collect(new GeminiChatModel());
    const usage = out.find((c) => c.kind === "usage")!;
    // Each model bills at its own rate — the fallback's name must be reported.
    expect(usage.model).toBeDefined();
    expect(usage.model).not.toBe("gemini-3-flash-preview");
  });

  it("U.2 no usageMetadata → no usage chunk (route falls back to estimates)", async () => {
    generateContentStream.mockResolvedValueOnce(
      (async function* () {
        yield { candidates: [{ content: { parts: [{ text: "hi" }] } }] };
      })(),
    );

    const out = await collect(new GeminiChatModel());
    expect(out).toEqual([{ kind: "delta", text: "hi" }]);
  });

  it("U.3 missing individual counts default to 0", async () => {
    generateContentStream.mockResolvedValueOnce(
      (async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: "hi" }] } }],
          usageMetadata: { promptTokenCount: 42 },
        };
      })(),
    );

    const out = await collect(new GeminiChatModel());
    expect(out[1]).toEqual({
      kind: "usage", text: "", model: "gemini-3-flash-preview",
      usage: { promptTokens: 42, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0 },
    });
  });
});
