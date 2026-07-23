// Safety-threshold posture (CLAUDE.md §3). These are Gemini's built-in
// safetySettings — the provider-side classifier that blocks a candidate with
// finishReason SAFETY. They run ON TOP of the deterministic input rules
// (safety.rules.ts) and the child-safety system prompt, and are pinned here so
// a change to the kids' safety posture can never happen silently.
//
// BUG-FIX-LOG 2026-07-22: HATE_SPEECH at BLOCK_LOW_AND_ABOVE false-positive
// blocked benign FAITH content — a church pastor's Sunday-school Bible game.
// The attribution logging (summarizeSafetyRatings) proved it: the block came
// solely from `HATE_SPEECH:LOW` (every other category NEGLIGIBLE).
//
// PRD-BIBLE-TEACHER (2026-07-23): that HATE_SPEECH LOW→MEDIUM relaxation is now
// RE-SCOPED to the bible-teacher persona (verified-adult authors) — see
// persona/persona.test.ts. The CHILD DEFAULT below is tightened back to the
// STRICTEST (HATE_SPEECH:LOW): faith games are authored through /bible-teacher,
// so the child default no longer pays for the false-positive latitude. This
// test pins the child-default (no-persona) posture; the persona posture is
// pinned in persona/persona.test.ts. HARASSMENT/SEXUALLY_EXPLICIT stay strictest.

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

async function* fakeStream(text: string) {
  yield { candidates: [{ content: { parts: [{ text }] } }] };
}

async function thresholdsSentToGemini(): Promise<Record<string, string>> {
  const model = new GeminiChatModel();
  for await (const _ of model.replyStream({ history: [], message: "make me a game" })) void _;
  const config = generateContentStream.mock.calls[0]![0] as {
    config: { safetySettings: Array<{ category: string; threshold: string }> };
  };
  return Object.fromEntries(config.config.safetySettings.map((s) => [s.category, s.threshold]));
}

describe("Gemini safetySettings — kids' safety posture (pinned)", () => {
  beforeEach(() => {
    generateContentStream.mockReset();
    generateContentStream.mockImplementation(() => fakeStream("ok"));
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "gemini-3-flash-preview";
  });

  it("child default HATE_SPEECH is STRICTEST (LOW) — the faith latitude moved to the bible-teacher persona", async () => {
    expect((await thresholdsSentToGemini())["hs"]).toBe("low");
  });

  it("HARASSMENT stays STRICTEST (LOW) — the block attribution showed it NEGLIGIBLE, not the culprit", async () => {
    expect((await thresholdsSentToGemini())["h"]).toBe("low");
  });

  it("SEXUALLY_EXPLICIT stays STRICTEST (LOW) — never relaxed for a kids' app", async () => {
    expect((await thresholdsSentToGemini())["se"]).toBe("low");
  });

  it("DANGEROUS_CONTENT stays MEDIUM (game-genre allowance, unchanged)", async () => {
    expect((await thresholdsSentToGemini())["dc"]).toBe("med");
  });
});
