// Pins the 4-deep model-fallback chain (BUG-FIX-LOG 2026-07-11, production;
// PRD-MODEL-FALLBACK §2/§3): capacity refusals and retired model ids walk
// DOWN the chain instead of sending the kid "Oops! Something went wrong.";
// real defects still throw immediately.
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

// No retry delays in tests.
vi.mock("./retry", () => ({
  withRetry: (fn: () => unknown) => fn(),
  withTimeout: (fn: () => unknown) => fn(),
}));

import { GeminiChatModel } from "./gemini";

async function* fakeStream(text: string) {
  yield { candidates: [{ content: { parts: [{ text }] } }] };
}

const overloadErr = () =>
  new Error(
    'got status: UNAVAILABLE. {"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
  );
const goneErr = () => new Error("404 NOT_FOUND: models/gemini-x is not found");

const calledModels = () => generateContentStream.mock.calls.map((c) => (c[0] as { model: string }).model);

async function collect(model: GeminiChatModel) {
  const out: { kind: string; text: string }[] = [];
  for await (const c of model.replyStream({ history: [], message: "make me a game" })) out.push(c);
  return out;
}

beforeEach(() => {
  generateContentStream.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
  // Prod shape: a primary OUTSIDE the default chain → all 4 fallbacks apply.
  process.env.GEMINI_CHAT_MODEL = "gemini-3.5-flash";
});

describe("GeminiChatModel — 4-deep fallback chain", () => {
  it("F.1 falls back to the next model when the primary is overloaded", async () => {
    generateContentStream
      .mockRejectedValueOnce(overloadErr())
      .mockResolvedValueOnce(fakeStream("Here's your game!"));

    const out = await collect(new GeminiChatModel());

    expect(out).toEqual([{ kind: "delta", text: "Here's your game!" }]);
    const models = calledModels();
    expect(models).toHaveLength(2);
    expect(models[1]).not.toBe(models[0]); // a DIFFERENT model, not a blind retry
  });

  it("F.2 non-capacity errors throw immediately — no fallback call burned", async () => {
    generateContentStream.mockRejectedValueOnce(new Error("400 INVALID_ARGUMENT: bad request"));

    await expect(collect(new GeminiChatModel())).rejects.toThrow(/chat stream failed/);
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it("F.3 walks the WHOLE owner-specified chain before giving up (2026-07-11)", async () => {
    generateContentStream.mockRejectedValue(overloadErr());

    await expect(collect(new GeminiChatModel())).rejects.toThrow(/chat stream failed/);
    expect(calledModels()).toEqual([
      "gemini-3.5-flash",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });

  it("F.4 a retired model id mid-chain is skipped, not fatal", async () => {
    generateContentStream
      .mockRejectedValueOnce(overloadErr()) // primary busy
      .mockRejectedValueOnce(goneErr()) // fallback 1 retired
      .mockResolvedValueOnce(fakeStream("Made it!")); // fallback 2 serves

    const out = await collect(new GeminiChatModel());

    expect(out).toEqual([{ kind: "delta", text: "Made it!" }]);
    expect(generateContentStream).toHaveBeenCalledTimes(3);
  });

  it("F.6 a stream that DIES MID-THINKING (opened, then 503 before any answer text) falls to the next model", async () => {
    // The prod incident's dominant shape: 3.5-flash accepts the stream, thinks
    // for minutes, then 503s — @433227ms in the 2026-07-11 pm2 log.
    async function* diesWhileThinking() {
      yield { candidates: [{ content: { parts: [{ text: "Planning the game…", thought: true }] } }] };
      throw overloadErr();
    }
    generateContentStream
      .mockResolvedValueOnce(diesWhileThinking())
      .mockResolvedValueOnce(fakeStream("Here's your game!"));

    const out = await collect(new GeminiChatModel());

    expect(out.at(-1)).toEqual({ kind: "delta", text: "Here's your game!" });
    expect(generateContentStream).toHaveBeenCalledTimes(2);
  });

  it("F.7 a stream that dies AFTER answer text started surfaces the error — never silently duplicate output", async () => {
    async function* diesMidAnswer() {
      yield { candidates: [{ content: { parts: [{ text: "<html>partial" }] } }] };
      throw overloadErr();
    }
    generateContentStream.mockResolvedValueOnce(diesMidAnswer());

    await expect(collect(new GeminiChatModel())).rejects.toThrow(/UNAVAILABLE/);
    expect(generateContentStream).toHaveBeenCalledTimes(1); // client auto-retry owns this case
  });

  it("F.5 a real defect mid-chain stops the walk — fallback never masks a bug", async () => {
    generateContentStream
      .mockRejectedValueOnce(overloadErr())
      .mockRejectedValueOnce(new Error("403 PERMISSION_DENIED: API key invalid"));

    await expect(collect(new GeminiChatModel())).rejects.toThrow(/PERMISSION_DENIED/);
    expect(generateContentStream).toHaveBeenCalledTimes(2); // stopped, models 3-5 untouched
  });
});
