// Gemini chat model. Single responsibility: turn a conversation into a draft reply.
// Knows nothing about safety or persistence. Server-only.

import "server-only";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
import type { ChatMessage, ChatModel, ImageAttachment, StreamChunk } from "@/types/chat.types";
import { isGameBuildTurn, builderGenOverrides } from "./builder-mode";
import { THREE_PROMPT_SECTION, modelsPromptSection, audioPromptSection, type PromptTurnContext } from "./assets/prompt-catalog";
import { catalogGates, type CatalogGates } from "./assets/catalog-gate";
import { fallbackChain, isModelGone, shouldTryNextModel } from "./model-fallback";
import { withRetry, withTimeout } from "./retry";

// A single generation shouldn't exceed this; beyond it we'd rather fail gracefully
// than leave a child staring at "Thinking…".
const CHAT_TIMEOUT_MS = 30_000;

// Exported so tests can pin the child-safety instruction (it replaced the
// Flash-Lite output monitor — see docs/BUG-FIX-LOG.md 2026-07-09).
export const CHILD_SYSTEM_PROMPT = `You are a friendly, encouraging assistant for a child aged between 7 and 14.
Be careful in the way you speak and be cautious about safety when answering,
because you are talking to a child aged between 7 and 14.
Speak simply and warmly. Keep answers short and clear. Be playful and curious.
Never produce anything scary, gory, sexual, hateful, or unsafe.
Games the child asks for are ALWAYS welcome — chess, puzzles, arcade games,
anything playful — never refuse a game request; just keep its content wholesome.
NEVER say a game is too complicated, and never deflect to a simpler, different
game — build the game the child asked for, complete and playable, in one go.
For rule-heavy classics (chess, checkers, sudoku), you may load a well-known
open-source library from a public CDN with <script src> (e.g. chess.js for
correct chess rules) so the game plays like a professional site; all other
games stay fully self-contained and offline (inline CSS + JS, no external
resources).
Classic video-game action IS fine and welcome — space shooters, laser blasters,
sword-and-shield adventures, dodging dino attacks, water-balloon battles, tank
games. Keep it cartoonish and bloodless: enemies "pop", "vanish" or "bounce away",
never bleed or suffer; no realistic weapons aimed at people, no gore, no cruelty.
If the ask is vague or open-ended ("make something cool", "a fun game"),
pick one fun, concrete interpretation yourself and start building it
immediately — do not list options or ask which one, and do not spend long
weighing interpretations; the child can always ask for changes after playing.
If the child asks for a game, respond with a single HTML document wrapped in a
\`\`\`html code block. The game MUST be easy and fun for a young child to control:
- Provide BOTH keyboard controls (Arrow keys / WASD) AND large on-screen buttons that work
  with mouse AND touch (kids often use tablets/phones). Buttons should respond to
  pointerdown/touchstart, not just click.
- Listen for keys on window/document (not a specific element) so controls work immediately
  without clicking first, and call event.preventDefault() on arrow/space keys so the page
  never scrolls while playing.
- Make movement smooth and forgiving — not too fast. Use requestAnimationFrame.
- The game MUST be fully responsive and fill WHATEVER container it runs in —
  it is played inside a small preview panel (~400px wide), on phones, and on
  desktops. html/body/the game area use width:100%/height:100dvh (NEVER 100vh,
  and no fixed pixel sizes like 800px) — plain "vh" includes the area a mobile
  browser's address bar can cover, so on-screen buttons pinned near the bottom
  of a 100vh layout get hidden behind it when a child opens the game's own
  link directly; "dvh" (dynamic viewport height) accounts for that. If you use
  a <canvas>, size it from its container on load AND on window resize
  (re-read clientWidth/clientHeight, scale positions accordingly). Nothing may
  overflow horizontally at 380px wide.
- Any on-screen control button pinned to the bottom of the screen needs a
  little breathing room below it (e.g. padding-bottom using
  max(12px, env(safe-area-inset-bottom))) so it's never flush against the
  very edge, where it's easiest for a mobile browser's UI to obscure it.
- Show simple on-screen instructions and the score; make all tap targets big.
  Render the score as an HTML element with id="score" (a real DOM element that
  updates as the player scores — not text drawn inside a canvas), so the
  Ariantra platform can track high scores automatically when it's published.
- Start the game loop immediately and synchronously when the script loads —
  never wrap the setup or the loop in an async function or behind an await:
  canvas sizing, world generation and the first requestAnimationFrame must all
  run straight away, so the game is visibly moving the moment it appears.
- The game must be winnable by a young child from the very first second:
  no enemy, obstacle or hazard may touch the player in the first 3 seconds of
  play; the player spawns at a safe distance from every hazard (never
  overlapping, never adjacent); the player always has at least one escape
  move available; difficulty ramps up — the first enemy starts slow and rare,
  and speed/spawn rate grow gradually with time or score.
- Keep it wholesome; work fully offline unless a CDN library is allowed above.`;

/** System instruction for a game-BUILD turn: the child-safety base plus
 *  whichever asset catalogs this turn's gates unlock (PRD-3D-GAMES-AND-ASSETS
 *  §9 — paid: both; free: keyword-invoked; 3D and audio independent). The
 *  default is fully unlocked — that's the paid/tests shape; configFor passes
 *  the real per-turn gates. Exported for the prompt-contract tests. */
export function buildTurnSystemInstruction(
  gates: CatalogGates = { three: true, audio: true },
  context?: PromptTurnContext,
): string {
  const sections = [
    ...(gates.three ? [THREE_PROMPT_SECTION, modelsPromptSection(undefined, context)] : []),
    ...(gates.audio ? [audioPromptSection()] : []),
  ].filter(Boolean);
  return sections.length ? `${CHILD_SYSTEM_PROMPT}\n\n${sections.join("\n\n")}` : CHILD_SYSTEM_PROMPT;
}

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
// Built-in safety is our real-time blocker when streaming; the system prompt above
// carries the child-safety instruction (the Flash-Lite monitor was removed 2026-07-09
// because it retracted harmless games like chess).
const GEN_CONFIG = {
  systemInstruction: CHILD_SYSTEM_PROMPT,
  maxOutputTokens: 8192,
  // gemini-2.5-* models "think" before emitting tokens — that silent phase can be tens of
  // seconds, so streaming shows nothing until it ends. Disable it for fast first-token,
  // chat-app-style responsiveness. GAME-BUILD turns override this with a bounded
  // budget + more output headroom (middle path, 2026-07-09 — see builder-mode.ts).
  thinkingConfig: { thinkingBudget: 0 },
  safetySettings: [
    // DANGEROUS_CONTENT at LOW blocked ordinary game-genre requests ("make me a
    // shooting game") — kids' arcade staples. MEDIUM still blocks real-world
    // dangerous content, and the deterministic input rules run on top.
    // Other categories stay at the strictest setting.
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  ],
};

/** Request shape sent to Gemini. Exported for tests (gemini.contents.test.ts pins it).
 *  An uploaded picture rides as inlineData on the FINAL user turn only — history
 *  never carries images (they aren't persisted; single-turn context by design). */
export function buildChatContents(input: { history: ChatMessage[]; message: string; image?: ImageAttachment }) {
  const lastParts: ({ text: string } | { inlineData: ImageAttachment })[] = input.image
    ? [{ inlineData: { mimeType: input.image.mimeType, data: input.image.data } }, { text: input.message }]
    : [{ text: input.message }];
  return [
    ...input.history.map((m) => ({
      role: m.role === "child" ? "user" : "model",
      parts: [{ text: m.text }] as ({ text: string } | { inlineData: ImageAttachment })[],
    })),
    { role: "user", parts: lastParts },
  ];
}

export class GeminiChatModel implements ChatModel {
  private model = process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash";
  // 4-deep fallback chain (PRD-MODEL-FALLBACK, owner decision 2026-07-11):
  // capacity refusals and retired model ids walk down the chain; anything
  // else throws at once. Slightly older code quality for a few minutes >>
  // "Oops! Something went wrong." for every kid.
  private fallbacks = fallbackChain(this.model, process.env);

  private buildContents(input: { history: ChatMessage[]; message: string; image?: ImageAttachment }) {
    return buildChatContents(input);
  }

  /** Fast chat config, or the builder overrides when this turn builds a game. */
  private configFor(input: { history: ChatMessage[]; message: string }) {
    if (!isGameBuildTurn(input.message, input.history)) return GEN_CONFIG;
    // paid: false until entitlement lands (TECH_DEBT #11) — then this becomes
    // the real per-user entitlement and the paid tier goes always-on (§9).
    const gates = catalogGates({ message: input.message, history: input.history, paid: false });
    console.log(`[gemini] builder mode — thinking on, extended output, catalogs: 3d=${gates.three} audio=${gates.audio}`);
    return {
      ...GEN_CONFIG,
      systemInstruction: buildTurnSystemInstruction(gates, { message: input.message, history: input.history }),
      ...builderGenOverrides(process.env),
    };
  }

  /** One-shot reply (used where streaming isn't needed). */
  async reply(input: { history: ChatMessage[]; message: string; image?: ImageAttachment }) {
    const ai = getClient();
    try {
      const res = await withRetry(
        () => withTimeout(
          () => ai.models.generateContent({
            model: this.model,
            contents: this.buildContents(input),
            config: this.configFor(input),
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

  /**
   * One-shot repair call (self-healing preview, PRD §7). Same model as
   * generation — repair needs the same code competence (§9) — but its own
   * system prompt (minimal-patch contract) and tighter output headroom:
   * a patch is ~8 lines, and output tokens dominate repair latency (§7.1).
   */
  async repair(input: { systemPrompt: string; prompt: string }): Promise<string> {
    const ai = getClient();
    try {
      const res = await withRetry(
        () => withTimeout(
          () => ai.models.generateContent({
            model: this.model,
            contents: [{ role: "user", parts: [{ text: input.prompt }] }],
            config: {
              ...GEN_CONFIG,
              systemInstruction: input.systemPrompt,
              maxOutputTokens: 4096,
            },
          }),
          CHAT_TIMEOUT_MS,
          "gemini.repair",
        ),
        { label: "gemini.repair", retries: 1 },
      );
      return res.text ?? "";
    } catch (err) {
      throw new GeminiError(`repair generation failed: ${(err as Error).message}`);
    }
  }

  /** Streaming reply — yields answer deltas AND thought summaries as they're
   *  generated. Thought parts (part.thought, includeThoughts in builder mode)
   *  become the kid-facing planning line; they are NOT part of the answer. */
  async *replyStream(input: { history: ChatMessage[]; message: string; image?: ImageAttachment }): AsyncGenerator<StreamChunk> {
    const ai = getClient();
    // Primary keeps its normal retries; each fallback gets ONE attempt so a
    // full incident walks the whole chain in ~a handful of tries, not 15
    // (latency the kid feels). The chain covers BOTH failure shapes from the
    // 2026-07-11 incident: refused at open, AND accepted-then-503-while-
    // THINKING (stream error @433s in the pm2 log) — the latter falls through
    // only while NO answer text has been sent (thoughts are ephemeral status
    // lines, safe to restart; visible answer text is not).
    const open = (model: string, retries: number) =>
      withRetry(
        () => ai.models.generateContentStream({
          model,
          contents: this.buildContents(input),
          config: this.configFor(input),
        }),
        { label: "gemini.chat.stream", retries },
      );
    const chain = [this.model, ...this.fallbacks];
    let answerStarted = false;
    let lastErr: unknown = null;
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i]!;
      if (i > 0) {
        console.warn(
          `[gemini] ${isModelGone(lastErr) ? "model gone (CHECK CONFIG)" : "overloaded"} — falling back to ${model}`,
        );
      }
      let stream;
      try {
        stream = await open(model, i === 0 ? 2 : 0);
      } catch (err) {
        lastErr = err;
        if (!shouldTryNextModel(err)) throw new GeminiError(`chat stream failed: ${(err as Error).message}`);
        continue;
      }
      try {
        for await (const chunk of stream) {
          // chunk.text would silently drop thought parts — walk the parts instead.
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const p of parts) {
            if (!p.text) continue;
            if (p.thought) {
              yield { kind: "thought", text: p.text };
            } else {
              answerStarted = true;
              yield { kind: "delta", text: p.text };
            }
          }
        }
        return; // finished cleanly
      } catch (err) {
        // Mid-stream death: only restartable while nothing user-visible went
        // out — after that, surface it (the client auto-retry keeps partials).
        if (answerStarted || !shouldTryNextModel(err)) throw err;
        lastErr = err;
        console.warn(`[gemini] ${model} died mid-thinking — trying the next model`);
      }
    }
    throw new GeminiError(`chat stream failed: ${(lastErr as Error).message}`);
  }
}
