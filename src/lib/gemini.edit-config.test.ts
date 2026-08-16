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

import { CHILD_PERSONA_CORE, CHILD_SYSTEM_PROMPT, buildTurnSystemInstruction, GeminiChatModel } from "./gemini";
import { GAME_EDIT_PROMPT_SECTION } from "./game-edit";

describe("buildTurnSystemInstruction — isEdit param", () => {
  it("defaults to NOT carrying the edit section (unchanged existing behavior)", () => {
    expect(buildTurnSystemInstruction()).not.toContain(GAME_EDIT_PROMPT_SECTION);
  });

  it("isEdit=true appends the edit section", () => {
    const full = buildTurnSystemInstruction({ three: true, audio: true }, true, true);
    expect(full).toContain(GAME_EDIT_PROMPT_SECTION);
  });

  it("isEdit=true still carries the child-safety base prompt (safety rules never dropped)", () => {
    // The intent of this test is unchanged and is the important one: the
    // child-audience framing and safety rules ride on EVERY turn. What changed
    // on 2026-08-16 is that the ~1,000-token BUILD contract (controls,
    // responsive layout, start screen, HUD design) no longer rides on edits —
    // the game already made those decisions, and the contract's opening line
    // ("respond with a single HTML document") flatly contradicts the patch
    // contract. Safety is a different thing from the build spec, and only the
    // build spec was trimmed.
    const full = buildTurnSystemInstruction({ three: false, audio: false }, false, true);
    expect(full.startsWith(CHILD_PERSONA_CORE)).toBe(true);
    expect(full).toContain("Never produce anything scary, gory, sexual, hateful, or unsafe.");
  });

  it("isEdit=true drops the FRESH-BUILD contract but keeps what an edit can break", () => {
    const full = buildTurnSystemInstruction({ three: false, audio: false }, false, true);
    // Gone: decisions the game already made.
    expect(full).not.toContain("respond with a single HTML document");
    expect(full).not.toContain("Show a START SCREEN");
    expect(full).not.toContain("backdrop-filter: blur(6px)");
    // Kept: things an edit can still get wrong.
    expect(full).toContain("landmark comment");
    expect(full).toContain('id="score"');
    expect(full).toContain("self-contained and offline");
  });

  it("a FRESH build still carries the whole build contract", () => {
    const build = buildTurnSystemInstruction({ three: false, audio: false }, false, false);
    expect(build.startsWith(CHILD_SYSTEM_PROMPT)).toBe(true);
    expect(build).toContain("respond with a single HTML document");
  });

  it("a plain-chat base keeps the full contract as its fallback", () => {
    // configFor's non-builder branch sends personaBasePrompt: if the router
    // called it chat but the child does ask for a game, the contract must
    // still be there.
    expect(CHILD_SYSTEM_PROMPT).toContain("respond with a single HTML document");
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
