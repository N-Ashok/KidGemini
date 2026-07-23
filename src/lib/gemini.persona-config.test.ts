// Persona wiring through configFor (PRD-BIBLE-TEACHER §6/§8). A build turn
// carrying persona='bible-teacher' must reach Gemini with BOTH the teacher
// system prompt AND the teacher safety thresholds; the same turn with no
// persona must reach it with the child prompt + strict child thresholds. This
// pins that the two travel together — a prompt swap without the matching safety
// swap (or vice-versa) is exactly the kind of half-change this guards.

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

import { GeminiChatModel, BIBLE_TEACHER_SYSTEM_PROMPT, CHILD_SYSTEM_PROMPT } from "./gemini";

async function* fakeStream(text: string) {
  yield { candidates: [{ content: { parts: [{ text }] } }] };
}

async function configSentFor(persona?: "default" | "bible-teacher") {
  generateContentStream.mockClear(); // isolate calls[0] when a test calls this twice
  const model = new GeminiChatModel();
  // A clear game-BUILD ask so configFor takes the builder branch.
  for await (const _ of model.replyStream({ history: [], message: "make me a game about David and Goliath", persona })) void _;
  const call = generateContentStream.mock.calls[0]![0] as {
    config: { systemInstruction: string; safetySettings: Array<{ category: string; threshold: string }> };
  };
  return {
    systemInstruction: call.config.systemInstruction,
    thresholds: Object.fromEntries(call.config.safetySettings.map((s) => [s.category, s.threshold])),
  };
}

describe("configFor — persona selects prompt AND safety together", () => {
  beforeEach(() => {
    generateContentStream.mockReset();
    generateContentStream.mockImplementation(() => fakeStream("```html\n<html></html>\n```"));
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "gemini-3-flash-preview";
  });

  it("bible-teacher persona → teacher system prompt", async () => {
    const { systemInstruction } = await configSentFor("bible-teacher");
    expect(systemInstruction).toContain("Sunday-school");
    expect(systemInstruction.startsWith(BIBLE_TEACHER_SYSTEM_PROMPT.slice(0, 60))).toBe(true);
    // Never leaks the child-audience opener into the teacher prompt.
    expect(systemInstruction).not.toContain("assistant for a child aged between 7 and 14");
  });

  it("bible-teacher persona → mandates the ESV translation", async () => {
    const { systemInstruction } = await configSentFor("bible-teacher");
    expect(systemInstruction).toMatch(/English Standard Version \(ESV\)/);
    // The child default must NOT carry the ESV directive (it's teacher-only).
    expect((await configSentFor("default")).systemInstruction).not.toMatch(/ESV/);
  });

  it("bible-teacher persona → HATE_SPEECH relaxed to MEDIUM", async () => {
    expect((await configSentFor("bible-teacher")).thresholds.hs).toBe("med");
  });

  it("no persona (default) → child system prompt + strict HATE_SPEECH (LOW)", async () => {
    const { systemInstruction, thresholds } = await configSentFor(undefined);
    expect(systemInstruction.startsWith(CHILD_SYSTEM_PROMPT.slice(0, 60))).toBe(true);
    expect(thresholds.hs).toBe("low");
  });

  it("both personas keep SEXUALLY_EXPLICIT strictest (LOW)", async () => {
    expect((await configSentFor("bible-teacher")).thresholds.se).toBe("low");
    expect((await configSentFor("default")).thresholds.se).toBe("low");
  });
});
