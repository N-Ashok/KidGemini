// BUG-FIX-LOG 2026-07-27: a kid's Pokémon-style battle game blocked on every
// edit with finishReason SAFETY, attribution [HARASSMENT:LOW, all else
// NEGLIGIBLE] — Gemini misreading benign battle language (trainers, gyms,
// rivals) at the child persona's strictest threshold. Verified live the same
// day: the identical ask passes when truthful "I am a game designer" context
// rides in the user turn (the system prompt already said it and did NOT help).
// Fix: replyStream injects CHILD_BUILDER_CONTEXT into the final user turn for
// CHILD-persona game-BUILD turns only — thresholds stay untouched (the safety
// posture is exactly as strict as before; see gemini.safety-config.test.ts).
// This file pins WHO gets the injection; the part layout is pinned in
// gemini.contents.test.ts.

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

import { GeminiChatModel, CHILD_BUILDER_CONTEXT } from "./gemini";
import type { ChatMessage } from "@/types/chat.types";
import type { PersonaId } from "./persona/persona";

async function* fakeStream(text: string) {
  yield { candidates: [{ content: { parts: [{ text }] } }] };
}

async function contentsSentToGemini(input: {
  message: string;
  history?: ChatMessage[];
  persona?: PersonaId;
}): Promise<Array<{ role: string; parts: Array<{ text?: string }> }>> {
  const model = new GeminiChatModel();
  for await (const _ of model.replyStream({ history: input.history ?? [], message: input.message, ...(input.persona ? { persona: input.persona } : {}) })) void _;
  const call = generateContentStream.mock.calls[0]![0] as {
    contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
  };
  return call.contents;
}

function finalTurnFirstText(contents: Array<{ role: string; parts: Array<{ text?: string }> }>): string | undefined {
  return contents[contents.length - 1]!.parts[0]!.text;
}

describe("child-builder safety context injection (pinned)", () => {
  beforeEach(() => {
    generateContentStream.mockReset();
    generateContentStream.mockImplementation(() => fakeStream("ok"));
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "gemini-3-flash-preview";
  });

  it("child game-BUILD turn gets CHILD_BUILDER_CONTEXT as the leading user part", async () => {
    const contents = await contentsSentToGemini({ message: "make me a game" });
    expect(finalTurnFirstText(contents)).toBe(CHILD_BUILDER_CONTEXT);
  });

  it("edit of an existing game (artifact in history, no 'game' word) is also a build turn — injected", async () => {
    const history: ChatMessage[] = [
      { id: "1", role: "child", text: "make me a game", createdAt: 1 },
      { id: "2", role: "assistant", text: "here!", createdAt: 2, artifactHtml: "<html>g</html>" },
    ];
    const contents = await contentsSentToGemini({ message: "add a mega evolution button", history });
    expect(finalTurnFirstText(contents)).toBe(CHILD_BUILDER_CONTEXT);
  });

  it("ordinary chat turn (not a build) is NOT injected — the child's words go as-is", async () => {
    const contents = await contentsSentToGemini({ message: "tell me a fun fact" });
    expect(finalTurnFirstText(contents)).toBe("tell me a fun fact");
    expect(JSON.stringify(contents)).not.toContain(CHILD_BUILDER_CONTEXT.slice(0, 20));
  });

  it("bible-teacher (verified adult) build turn is NOT injected — adults have their own persona latitude", async () => {
    const contents = await contentsSentToGemini({ message: "make me a quiz game", persona: "bible-teacher" });
    expect(finalTurnFirstText(contents)).toBe("make me a quiz game");
  });

  it("the context is truthful child-designer framing (the shape verified live 2026-07-27)", () => {
    expect(CHILD_BUILDER_CONTEXT).toMatch(/game designer/i);
    expect(CHILD_BUILDER_CONTEXT).toMatch(/fiction|make-believe|cartoon/i);
  });
});
