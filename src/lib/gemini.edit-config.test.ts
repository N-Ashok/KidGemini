// Patch-based feature edits (BUG-FIX-LOG class fix, 2026-07-18): edit turns
// get GAME_EDIT_PROMPT_SECTION appended to the system instruction instead of
// (or alongside) the plain build one — same append pattern as
// THREE_PROMPT_SECTION / MULTIPLAYER_PROMPT_SECTION already use.

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

import { CHILD_SYSTEM_PROMPT, CHILD_SAFETY_CORE, EDIT_CRAFT_RULES, buildTurnSystemInstruction, GeminiChatModel } from "./gemini";
import { GAME_EDIT_PROMPT_SECTION } from "./game-edit";

describe("buildTurnSystemInstruction — isEdit param", () => {
  it("defaults to NOT carrying the edit section (unchanged existing behavior)", () => {
    expect(buildTurnSystemInstruction()).not.toContain(GAME_EDIT_PROMPT_SECTION);
  });

  it("isEdit=true appends the edit section", () => {
    const full = buildTurnSystemInstruction({ three: true, audio: true }, true, true);
    expect(full).toContain(GAME_EDIT_PROMPT_SECTION);
  });

  // 2026-08-25 (owner decision, plan noble-orbiting-stallman): an edit turn
  // carries the child-safety CORE (never dropped — rule 3) plus edit craft
  // rules, not the full build prompt. gemini.prompt.test.ts ED.* pins the shape.
  it("isEdit=true still carries the child-safety core (safety rules never dropped)", () => {
    const full = buildTurnSystemInstruction({ three: false, audio: false }, false, true);
    expect(full.startsWith(CHILD_SAFETY_CORE)).toBe(true);
    expect(full).toMatch(/scary, gory, sexual, hateful, or unsafe/);
  });

  it("isEdit=true with everything else off is exactly safety core + edit craft + edit section", () => {
    const full = buildTurnSystemInstruction({ three: false, audio: false }, false, true);
    expect(full).toBe(`${CHILD_SAFETY_CORE}\n${EDIT_CRAFT_RULES}\n\n${GAME_EDIT_PROMPT_SECTION}`);
  });
});

async function* fakeStream(text: string) {
  yield { candidates: [{ content: { parts: [{ text }] } }] };
}

describe("GeminiChatModel.configFor — routes edit turns to the edit system instruction", () => {
  beforeEach(() => {
    generateContentStream.mockReset();
    generateContentStream.mockImplementation(() => fakeStream("ok"));
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "gemini-3-flash-preview";
  });

  it("a fresh build (no game in history) does NOT get the edit section", async () => {
    const model = new GeminiChatModel();
    for await (const _ of model.replyStream({ history: [], message: "make me a racing game" })) void _;
    const config = generateContentStream.mock.calls[0]![0] as { config: { systemInstruction: string } };
    expect(config.config.systemInstruction).not.toContain(GAME_EDIT_PROMPT_SECTION);
  });

  it("a follow-up on an already-built game gets the edit section", async () => {
    const model = new GeminiChatModel();
    const history = [
      { id: "1", role: "child" as const, text: "make me a racing game", createdAt: 1 },
      {
        id: "2", role: "assistant" as const,
        text: "Here!\n```html\n<!doctype html><html><body>GAME</body></html>\n```",
        artifactHtml: "<!doctype html><html><body>GAME</body></html>",
        createdAt: 2,
      },
    ];
    for await (const _ of model.replyStream({ history, message: "make the car faster" })) void _;
    const config = generateContentStream.mock.calls[0]![0] as { config: { systemInstruction: string } };
    expect(config.config.systemInstruction).toContain(GAME_EDIT_PROMPT_SECTION);
  });
});
