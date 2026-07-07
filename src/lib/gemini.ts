// Gemini chat model. Single responsibility: turn a conversation into a draft reply.
// Knows nothing about safety or persistence. Server-only.

import "server-only";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
import type { ChatMessage, ChatModel } from "@/types/chat.types";
import { withRetry, withTimeout } from "./retry";

// A single generation shouldn't exceed this; beyond it we'd rather fail gracefully
// than leave a child staring at "Thinking…".
const CHAT_TIMEOUT_MS = 30_000;

const CHILD_SYSTEM_PROMPT = `You are a friendly, encouraging assistant for a child (about 6-12 years old).
Speak simply and warmly. Keep answers short and clear. Be playful and curious.
Never produce anything scary, gory, sexual, hateful, or unsafe.
Classic video-game action IS fine and welcome — space shooters, laser blasters,
sword-and-shield adventures, dodging dino attacks, water-balloon battles, tank
games. Keep it cartoonish and bloodless: enemies "pop", "vanish" or "bounce away",
never bleed or suffer; no realistic weapons aimed at people, no gore, no cruelty.
If the child asks for a game, respond with a single self-contained HTML document
(inline CSS + JS, no external resources) wrapped in a \`\`\`html code block. The game MUST
be easy and fun for a young child to control:
- Provide BOTH keyboard controls (Arrow keys / WASD) AND large on-screen buttons that work
  with mouse AND touch (kids often use tablets/phones). Buttons should respond to
  pointerdown/touchstart, not just click.
- Listen for keys on window/document (not a specific element) so controls work immediately
  without clicking first, and call event.preventDefault() on arrow/space keys so the page
  never scrolls while playing.
- Make movement smooth and forgiving — not too fast. Use requestAnimationFrame.
- The game MUST be fully responsive and fill WHATEVER container it runs in —
  it is played inside a small preview panel (~400px wide), on phones, and on
  desktops. html/body/the game area use width:100%/height:100% (no fixed pixel
  sizes like 800px). If you use a <canvas>, size it from its container on load
  AND on window resize (re-read clientWidth/clientHeight, scale positions
  accordingly). Nothing may overflow horizontally at 380px wide.
- Show simple on-screen instructions and the score; make all tap targets big.
  Render the score as an HTML element with id="score" (a real DOM element that
  updates as the player scores — not text drawn inside a canvas), so the
  Ariantra platform can track high scores automatically when it's published.
- Keep it wholesome and work fully offline.`;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiError("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey });
}

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiError";
  }
}

/**
 * Pulls an HTML game out of the model's reply. Tolerant of three cases so a truncated
 * or unfenced response still renders instead of dumping raw code into the chat:
 *  1. a properly closed ```html … ``` block,
 *  2. an opened ```html … that got cut off (no closing fence),
 *  3. no fence at all but a real <!doctype html> / <html> document in the text.
 */
export function extractArtifact(text: string): { text: string; artifactHtml?: string } {
  const done = "Here's your game! 🎮";

  const closed = text.match(/```html\s*([\s\S]*?)```/i);
  if (closed) {
    return { text: text.replace(closed[0], "").trim() || done, artifactHtml: closed[1]?.trim() };
  }

  const openOnly = text.match(/```html\s*([\s\S]*)$/i);
  if (openOnly && /<\w+[\s>/]/.test(openOnly[1] ?? "")) {
    return {
      text: text.slice(0, openOnly.index).trim() || done,
      artifactHtml: (openOnly[1] ?? "").trim(),
    };
  }

  const docIdx = text.search(/<!doctype html|<html[\s>]/i);
  if (docIdx !== -1) {
    return {
      text: text.slice(0, docIdx).trim() || done,
      artifactHtml: text.slice(docIdx).replace(/```\s*$/, "").trim(),
    };
  }

  return { text };
}

// Shared generation config — strict built-in safety + token headroom for full games.
// Built-in safety is our real-time blocker when streaming (the Flash-Lite gate then runs
// as a parallel monitor rather than a serial pre-display gate).
const GEN_CONFIG = {
  systemInstruction: CHILD_SYSTEM_PROMPT,
  maxOutputTokens: 8192,
  // gemini-2.5-* models "think" before emitting tokens — that silent phase can be tens of
  // seconds, so streaming shows nothing until it ends. Disable it for fast first-token,
  // chat-app-style responsiveness. (Set a budget > 0 later if you want deeper reasoning.)
  thinkingConfig: { thinkingBudget: 0 },
  safetySettings: [
    // DANGEROUS_CONTENT at LOW blocked ordinary game-genre requests ("make me a
    // shooting game") — kids' arcade staples. MEDIUM still blocks real-world
    // dangerous content, and our own two-layer gate (rules + Flash-Lite
    // classifier) runs on top. Other categories stay at the strictest setting.
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  ],
};

export class GeminiChatModel implements ChatModel {
  private model = process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash";

  private buildContents(input: { history: ChatMessage[]; message: string }) {
    return [
      ...input.history.map((m) => ({
        role: m.role === "child" ? "user" : "model",
        parts: [{ text: m.text }],
      })),
      { role: "user", parts: [{ text: input.message }] },
    ];
  }

  /** One-shot reply (used where streaming isn't needed). */
  async reply(input: { history: ChatMessage[]; message: string }) {
    const ai = getClient();
    try {
      const res = await withRetry(
        () => withTimeout(
          () => ai.models.generateContent({
            model: this.model,
            contents: this.buildContents(input),
            config: GEN_CONFIG,
          }),
          CHAT_TIMEOUT_MS,
          "gemini.chat",
        ),
        { label: "gemini.chat", retries: 2 },
      );
      return extractArtifact(res.text ?? "");
    } catch (err) {
      throw new GeminiError(`chat generation failed: ${(err as Error).message}`);
    }
  }

  /** Streaming reply — yields text deltas as they're generated (Gemini-like). */
  async *replyStream(input: { history: ChatMessage[]; message: string }): AsyncGenerator<string> {
    const ai = getClient();
    let stream;
    try {
      stream = await withRetry(
        () => ai.models.generateContentStream({
          model: this.model,
          contents: this.buildContents(input),
          config: GEN_CONFIG,
        }),
        { label: "gemini.chat.stream", retries: 2 },
      );
    } catch (err) {
      throw new GeminiError(`chat stream failed: ${(err as Error).message}`);
    }
    for await (const chunk of stream) {
      const t = chunk.text;
      if (t) yield t;
    }
  }
}
