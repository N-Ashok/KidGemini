// Wiring test for Pass 1 of the two-pass build pipeline (owner ask
// 2026-08-12, spec-compiler.ts). Confirms:
//  - flag OFF (default): replyStream sends the child's raw message,
//    byte-identical to before this feature existed (rule 11 — nothing
//    live-facing changes uninvited).
//  - flag ON + a fresh build turn: Pass 1 compiles a spec first (on its own
//    model/chain) and Pass 2 (unchanged) builds from THAT text.
//  - Pass 1 failing outright never blocks the build (fail-open).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const generateContent = vi.fn();
const generateContentStream = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: (...a: unknown[]) => generateContent(...a),
      generateContentStream: (...a: unknown[]) => generateContentStream(...a),
    };
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

async function* fakeStream(text: string) {
  yield { candidates: [{ content: { parts: [{ text }] } }] };
}

async function collect(model: GeminiChatModel, message: string) {
  const out: { kind: string; text: string }[] = [];
  for await (const c of model.replyStream({ history: [], message })) out.push(c);
  return out;
}

const lastBuilderMessageText = () => {
  const calls = generateContentStream.mock.calls;
  const call = calls[calls.length - 1]!;
  const contents = (call[0] as { contents: { role: string; parts: { text?: string }[] }[] }).contents;
  const lastUserTurn = contents[contents.length - 1]!;
  return lastUserTurn.parts.map((p) => p.text ?? "").join("");
};

beforeEach(() => {
  generateContent.mockReset();
  generateContentStream.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_CHAT_MODEL = "gemini-3-flash-preview";
  delete process.env.SPEC_COMPILER_ENABLED;
  delete process.env.SPEC_COMPILER_MODEL;
});

describe("GeminiChatModel — Pass 1 spec compiler (off by default)", () => {
  it("SPEC_COMPILER_ENABLED unset: no compile call, the raw message reaches the builder unchanged", async () => {
    generateContentStream.mockResolvedValueOnce(fakeStream("<html>game</html>"));

    await collect(new GeminiChatModel(), "make me a lemonade game");

    expect(generateContent).not.toHaveBeenCalled();
    expect(lastBuilderMessageText()).toContain("make me a lemonade game");
  });
});

describe("GeminiChatModel — Pass 1 spec compiler (enabled)", () => {
  beforeEach(() => {
    process.env.SPEC_COMPILER_ENABLED = "1";
    process.env.SPEC_COMPILER_MODEL = "gemini-2.5-flash-lite"; // no DEEPSEEK_API_KEY in test env
  });

  it("a fresh build turn: Pass 1's spec, not the raw message, reaches the Pass 2 builder", async () => {
    generateContent.mockResolvedValueOnce({ text: "## 1. WHAT THIS IS\nA lemonade stand game." });
    generateContentStream.mockResolvedValueOnce(fakeStream("<html>game</html>"));

    await collect(new GeminiChatModel(), "make me a lemonade game");

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect((generateContent.mock.calls[0]![0] as { model: string }).model).toBe("gemini-2.5-flash-lite");
    expect(lastBuilderMessageText()).toContain("## 1. WHAT THIS IS\nA lemonade stand game.");
    expect(lastBuilderMessageText()).not.toContain("make me a lemonade game");
  });

  it("an edit turn (game already exists) skips Pass 1 entirely", async () => {
    generateContentStream.mockResolvedValueOnce(fakeStream("<html>edited</html>"));

    const model = new GeminiChatModel();
    const out: { kind: string; text: string }[] = [];
    for await (const c of model.replyStream({
      history: [{ id: "m1", role: "assistant", text: "here", artifactHtml: "<html>old</html>", createdAt: 1755000000000 }],
      message: "add a jump button",
    })) out.push(c);

    expect(generateContent).not.toHaveBeenCalled();
    expect(lastBuilderMessageText()).toContain("add a jump button");
  });

  it("Pass 1 failing outright still lets Pass 2 build from the raw message (fail-open)", async () => {
    generateContent.mockRejectedValue(new Error("400 INVALID_ARGUMENT: bad request"));
    generateContentStream.mockResolvedValueOnce(fakeStream("<html>game</html>"));

    const out = await collect(new GeminiChatModel(), "make me a lemonade game");

    expect(out).toEqual([{ kind: "delta", text: "<html>game</html>" }]);
    expect(lastBuilderMessageText()).toContain("make me a lemonade game");
  });
});
