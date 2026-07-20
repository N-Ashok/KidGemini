// "🔄 Different one" (PRD-INSTANT-ALTERNATE, on-demand): replyStream with
// preferAlternateModel leads the chain with the FALLBACK model, so the redo is a
// genuinely different model's take — no runner surgery, the hedge/restart logic
// is untouched. Same harness as gemini.fallback.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const generateContentStream = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContentStream: (...a: unknown[]) => generateContentStream(...a) };
  },
  HarmCategory: { HARM_CATEGORY_HARASSMENT: "h", HARM_CATEGORY_HATE_SPEECH: "hs", HARM_CATEGORY_SEXUALLY_EXPLICIT: "se", HARM_CATEGORY_DANGEROUS_CONTENT: "dc" },
  HarmBlockThreshold: { BLOCK_LOW_AND_ABOVE: "low", BLOCK_MEDIUM_AND_ABOVE: "med" },
}));

vi.mock("./retry", () => ({ withRetry: (fn: () => unknown) => fn(), withTimeout: (fn: () => unknown) => fn() }));

import { GeminiChatModel } from "./gemini";

async function* fakeStream(text: string) {
  yield { candidates: [{ content: { parts: [{ text }] } }] };
}
const calledModels = () => generateContentStream.mock.calls.map((c) => (c[0] as { model: string }).model);

async function collect(model: GeminiChatModel, preferAlternateModel: boolean) {
  const out: { kind: string; text: string }[] = [];
  for await (const c of model.replyStream({ history: [], message: "make me a game", preferAlternateModel })) out.push(c);
  return out;
}

beforeEach(() => {
  generateContentStream.mockReset();
  process.env.GEMINI_API_KEY = "g";
  process.env.GEMINI_CHAT_MODEL = "gemini-3.5-flash"; // frontier primary → real fallbacks exist
});

describe("Different one — regenerate led by the fallback model", () => {
  it("DA.1 with preferAlternateModel, the FIRST model tried is a fallback, not the primary", async () => {
    generateContentStream.mockResolvedValue(fakeStream("A different take!"));

    const out = await collect(new GeminiChatModel(), true);

    expect(out.at(-1)).toEqual({ kind: "delta", text: "A different take!" });
    expect(calledModels()[0]).not.toBe("gemini-3.5-flash"); // led by a fallback
  });

  it("DA.2 without the flag, the primary leads as usual (behaviour unchanged)", async () => {
    generateContentStream.mockResolvedValue(fakeStream("Normal!"));

    await collect(new GeminiChatModel(), false);

    expect(calledModels()[0]).toBe("gemini-3.5-flash");
  });

  it("DA.3 the primary is still in the chain as a backup (nothing is dropped)", async () => {
    // First (fallback) model fails → the walk must still reach the primary.
    const overload = () => new Error('got status: UNAVAILABLE {"error":{"code":503,"status":"UNAVAILABLE"}}');
    generateContentStream.mockRejectedValue(overload());

    await expect(collect(new GeminiChatModel(), true)).rejects.toThrow(/chat stream failed/);
    expect(calledModels()).toContain("gemini-3.5-flash"); // primary tried, just last
  });
});
