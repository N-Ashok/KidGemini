// Gemini chat model. Single responsibility: turn a conversation into a draft reply.
// Knows nothing about safety or persistence. Server-only.

import "server-only";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from "@google/genai";
import type { ChatMessage, ChatModel, ImageAttachment, StreamChunk, TokenUsage } from "@/types/chat.types";
import type { ChainSummary } from "@/types/model-ledger.types";
import { isGameBuildTurn, builderGenOverrides } from "./builder-mode";
import { THREE_PROMPT_SECTION, modelsPromptSection, audioPromptSection, type PromptTurnContext } from "./assets/prompt-catalog";
import { catalogGates, type CatalogGates } from "./assets/catalog-gate";
import { multiplayerGate } from "./multiplayer-gate";
import { MULTIPLAYER_PROMPT_SECTION } from "./multiplayer-prompt";
import {
  isGameEditTurn, isRepeatedRequest, GAME_EDIT_PROMPT_SECTION,
  GAME_EDIT_STRICT_RETRY_SECTION, REPEATED_REQUEST_SECTION, FRESH_GAME_LINE,
} from "./game-edit";
import { fallbackChain, isModelGone, shouldTryNextModel } from "./model-fallback";
import { runOneShotChain, runStreamChain, type ProviderChunk, type FinishReason, type ProviderGenerator } from "./model-runner";
import { chainFor, specFor } from "./model-registry";
import { openaiAdapter } from "./providers/openai-adapter";
import { anthropicAdapter } from "./providers/anthropic-adapter";
import { moonshotAdapter } from "./providers/moonshot-adapter";
import { OpenAIGenerator } from "./providers/openai-generation";
import { AnthropicGenerator } from "./providers/anthropic-generation";
import { MoonshotGenerator } from "./providers/moonshot-generation";
import type { GenerationRequest, ProviderAdapter, ProviderId } from "@/types/model-provider.types";
import { withRetry } from "./retry";

// A single generation shouldn't exceed this; beyond it we'd rather fail gracefully
// than leave a child staring at "Thinking…". Applies to ordinary one-shot calls
// (plain chat, repairs) — a full game BUILD gets BUILD_TIMEOUT_MS below.
const CHAT_TIMEOUT_MS = 30_000;

/**
 * Deadline for a one-shot call that BUILDS A WHOLE GAME (the patch-fallback
 * regeneration in api/chat/route.ts). BUG-FIX-LOG 2026-07-20 — the root cause
 * of "walked four fallbacks and returned nothing":
 *
 * A builder turn runs with thinking ON and maxOutputTokens 24576, and prod logs
 * show successful game streams finishing at 31.2s and 46.4s. The one-shot path
 * gave that same work 30s — BELOW the observed median — so every model timed
 * out, deterministically, and the chain burned 225s before failing. Streaming
 * never hit this because it has no wall-clock cap at all: its watchdog is a
 * per-chunk stall timer that resets on every chunk, so a 46s stream is fine.
 *
 * Sized off those measurements with headroom. Env-overridable so an operator
 * can tune it against real turns without a deploy.
 */
// 60s, not 120s (owner decision 2026-07-20): with the one-shot chain no longer
// DISCARDING attempts, a shorter slot deadline is strictly better. It starts a
// backup sooner while the primary keeps running — and the primary, already 60s
// into its work, still beats a backup starting from zero. A long serial
// deadline only delays the backup without protecting the good answer.
const BUILD_TIMEOUT_MS = 60_000;

/**
 * How many models a ONE-SHOT turn may involve, and the hard ceiling on the
 * child's wait (2026-07-20 guard-rail).
 *
 * Keeping attempts alive is right, but it makes DEPTH dangerous: the auto
 * chain is up to 5 models, and at a 60s slot each that is a 360s worst case —
 * worse than the 225s incident the change was fixing. A child waiting six
 * minutes is a failure no matter how good the answer eventually is.
 *
 * Depth 2 (primary + one backup) covers both real cases: a SLOW primary still
 * wins because it keeps running, and a DEAD primary is covered by the backup.
 * A third backup would start around 120s and land near 160s — past the point
 * where anyone is still waiting — so it only adds cost and risk.
 *
 * The budget must stay ≥ one slot plus the slowest observed build (60s +
 * 46.4s), or we would start a backup and then kill it before it can finish:
 * precisely the discard-the-nearly-done waste this work exists to remove.
 */
export const ONESHOT_MAX_MODELS = 2;
export const ONESHOT_TOTAL_BUDGET_MS = 150_000;

export function oneShotBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const override = Number(env.GEMINI_ONESHOT_BUDGET_MS);
  return Number.isFinite(override) && override > 0 ? override : ONESHOT_TOTAL_BUDGET_MS;
}

/**
 * Which deadline a one-shot call gets. Exported pure so the choice is testable
 * without mocking timers — the incident was a *value* being wrong, not the
 * timeout machinery.
 */
export function oneShotTimeoutMs(
  input: { message: string; history: ChatMessage[] },
  env: Record<string, string | undefined> = process.env,
): number {
  if (!isGameBuildTurn(input.message, input.history)) return CHAT_TIMEOUT_MS;
  const override = Number(env.GEMINI_BUILD_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : BUILD_TIMEOUT_MS;
}

// Hedged generation (owner decision 2026-07-13): a model that emits NO chunks
// at all — not even thought summaries — for this long gets a HEDGE: the next
// chain model starts IN PARALLEL (the slow one is not killed), and whichever
// produces the first answer token wins; the loser is abandoned unconsumed.
// At most ONE hedge per turn (no thundering herd — matters most exactly when
// Google is overloaded). Healthy builder turns stream thought summaries well
// inside this window. Env override: GEMINI_STALL_SWITCH_MS.
const STALL_SWITCH_MS = 30_000;

/** Unified one-shot result — the Google path and every non-Google generator
 *  normalize to this, so reply()/repair()/strictEditRetry() never branch on
 *  provider (cross-provider one-shot, E 2026-07-20). */
type OneShotResult = { text: string; usage?: TokenUsage };

/** Gemini usageMetadata fields we bill on (all optional in the SDK). */
interface GenUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

/** Final stream chunk carrying the real billed token counts and the model
 *  that actually served the reply (fallback/hedge can differ from primary). */
function usageChunk(u: GenUsageMetadata, model?: string): StreamChunk {
  return {
    kind: "usage",
    text: "",
    ...(model ? { model } : {}),
    usage: {
      promptTokens: u.promptTokenCount ?? 0,
      outputTokens: u.candidatesTokenCount ?? 0,
      thoughtTokens: u.thoughtsTokenCount ?? 0,
      cachedTokens: u.cachedContentTokenCount ?? 0,
    },
  };
}

/**
 * Gemini stream → normalized ProviderChunk stream (cross-provider refactor
 * 2026-07-20). One chunk can carry several parts, and `chunk.text` would
 * silently DROP thought parts, so walk parts explicitly — the kid-facing
 * planning line is built from them.
 *
 * `for await` (not a manual iterator) is deliberate: it propagates an early
 * `return()` to the underlying SDK stream, which is what makes the runner's
 * hedge-loser `abandon()` actually close the abandoned Google stream instead
 * of leaking it for the rest of the turn.
 */
async function* toProviderChunks(
  stream: AsyncIterable<{
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
      safetyRatings?: Array<{ category?: string; probability?: string; blocked?: boolean }>;
    }>;
    usageMetadata?: GenUsageMetadata;
  }>,
): AsyncGenerator<ProviderChunk> {
  for await (const chunk of stream) {
    const usage = chunk.usageMetadata ? usageChunk(chunk.usageMetadata).usage : undefined;
    const finishReason = normalizeFinishReason(chunk.candidates?.[0]?.finishReason);
    // Only carry safety ratings on a SAFETY finish — that's the block we want to
    // attribute; on a normal turn they're just noise.
    const safetyInfo = finishReason === "safety" ? summarizeSafetyRatings(chunk.candidates?.[0]?.safetyRatings) : undefined;
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    if (parts.length === 0) {
      // A usage- or finishReason-only chunk still has to reach the runner —
      // the terminal chunk of a SAFETY/MAX_TOKENS block often has no parts.
      if (usage || finishReason) yield { ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}), ...(safetyInfo ? { safetyInfo } : {}) };
      continue;
    }
    for (const p of parts) yield { text: p.text, thought: p.thought, ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}), ...(safetyInfo ? { safetyInfo } : {}) };
  }
}

/**
 * Gemini finishReason → the runner's normalized enum (KNOWN_BUGS #4). Every
 * content-BLOCK verdict maps to `safety` and fails closed (never retried on
 * another model) — SAFETY plus the sibling block reasons (PROHIBITED_CONTENT,
 * BLOCKLIST, SPII), because on a product for 7-14 year olds a block is a
 * decision, not an outage. RECITATION (copyright) stays `other` — a reword on
 * the next model can legitimately help. MAX_TOKENS is the fixable case.
 */
function normalizeFinishReason(raw?: string): FinishReason | undefined {
  if (!raw) return undefined;
  const r = raw.toUpperCase();
  if (r === "SAFETY" || r === "PROHIBITED_CONTENT" || r === "BLOCKLIST" || r === "SPII") return "safety";
  if (r === "MAX_TOKENS") return "max_tokens";
  if (r === "STOP") return "stop";
  return "other";
}

/** Compact, human-readable summary of a candidate's per-category safety ratings,
 *  so a SAFETY block logs WHICH category fired at what confidence — the info a
 *  parent alert / cost dashboard needs to tell a genuine block from a
 *  false-positive on benign content (owner ask 2026-07-22: a pastor's Bible game
 *  keeps getting blocked; we can't tell HATE_SPEECH from HARASSMENT today). No
 *  posture change — this only surfaces what Gemini already reports. Prefers the
 *  explicitly-blocked category, else anything above NEGLIGIBLE/LOW, else all.
 *  e.g. "HATE_SPEECH:MEDIUM(blocked)". Returns undefined when there's nothing. */
export function summarizeSafetyRatings(
  ratings?: Array<{ category?: string; probability?: string; blocked?: boolean }>,
): string | undefined {
  if (!ratings?.length) return undefined;
  const label = (c?: string) => (c ?? "?").replace(/^HARM_CATEGORY_/, "");
  const blocked = ratings.filter((r) => r.blocked);
  const notable = blocked.length
    ? blocked
    : ratings.filter((r) => r.probability && !["NEGLIGIBLE", "LOW"].includes(r.probability.toUpperCase()));
  const show = notable.length ? notable : ratings;
  return show.map((r) => `${label(r.category)}:${r.probability ?? "?"}${r.blocked ? "(blocked)" : ""}`).join(", ") || undefined;
}

/** Halves the thinking budget for the ONE MAX_TOKENS retry (KNOWN_BUGS #4) so
 *  the output allowance isn't consumed by thinking. Floors at 0; leaves every
 *  other config field (safety settings, output cap) untouched. */
function withReducedThinkingBudget<T extends { thinkingConfig?: { thinkingBudget?: number } }>(config: T): T {
  const current = config.thinkingConfig?.thinkingBudget ?? 0;
  return { ...config, thinkingConfig: { ...config.thinkingConfig, thinkingBudget: Math.max(0, Math.floor(current / 2)) } };
}

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
 *  §9 — paid: both; free: keyword-invoked; 3D and audio independent), plus the
 *  multiplayer section (PRD-MULTIPLAYER.md Phase 4) gated independently — a
 *  multiplayer game can be plain 2D and silent, so it isn't a CatalogGates
 *  field. The default is fully unlocked — that's the paid/tests shape;
 *  configFor passes the real per-turn gates. Exported for the prompt-contract
 *  tests. */
export function buildTurnSystemInstruction(
  gates: CatalogGates = { three: true, audio: true },
  context?: PromptTurnContext,
  multiplayer = true,
  isEdit = false,
  repeated = false,
): string {
  const sections = [
    ...(gates.three ? [THREE_PROMPT_SECTION, modelsPromptSection(undefined, context)] : []),
    ...(gates.audio ? [audioPromptSection()] : []),
    ...(multiplayer ? [MULTIPLAYER_PROMPT_SECTION] : []),
    ...(isEdit ? [GAME_EDIT_PROMPT_SECTION] : []),
    ...(repeated ? [REPEATED_REQUEST_SECTION] : []),
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
 * `wasFenced` tells the caller which: only cases 2/3 leave raw, unfenced HTML/CSS/JS
 * in the ORIGINAL text — a caller that displays the original text as markdown
 * (api/chat/route.ts) must re-fence it before rendering, or the raw code's own
 * indentation gets misparsed as CommonMark indented code blocks (BUG-FIX-LOG 2026-07-14).
 */
export function extractArtifact(text: string): { text: string; artifactHtml?: string; wasFenced?: boolean } {
  // Shared with game-edit.ts so the route can RECOGNIZE this default: fine on
  // a fresh build, misleading on a turn that replaced an existing game.
  const done = FRESH_GAME_LINE;

  const closed = text.match(/```html\s*([\s\S]*?)```/i);
  if (closed) {
    return { text: text.replace(closed[0], "").trim() || done, artifactHtml: closed[1]?.trim(), wasFenced: true };
  }

  const openOnly = text.match(/```html\s*([\s\S]*)$/i);
  if (openOnly && /<\w+[\s>/]/.test(openOnly[1] ?? "")) {
    return {
      text: text.slice(0, openOnly.index).trim() || done,
      artifactHtml: (openOnly[1] ?? "").trim(),
      wasFenced: false,
    };
  }

  const docIdx = text.search(/<!doctype html|<html[\s>]/i);
  if (docIdx !== -1) {
    return {
      text: text.slice(0, docIdx).trim() || done,
      artifactHtml: text.slice(docIdx).replace(/```\s*$/, "").trim(),
      wasFenced: false,
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
    // Thresholds are pinned + explained in gemini.safety-config.test.ts.
    // DANGEROUS_CONTENT at LOW blocked ordinary game-genre requests ("make me a
    // shooting game") — kids' arcade staples. MEDIUM still blocks real-world
    // dangerous content, and the deterministic input rules run on top.
    // HATE_SPEECH relaxed LOW→MEDIUM (owner call 2026-07-22, BUG-FIX-LOG): a
    // church pastor's Sunday-school Bible game was blocked SOLELY by
    // HATE_SPEECH:LOW (proven by the safety-block attribution log; every other
    // category NEGLIGIBLE) — religion is a protected attribute, so benign faith
    // content trips a LOW flag. MEDIUM+ still blocks genuine hate. HARASSMENT +
    // SEXUALLY_EXPLICIT stay at the STRICTEST — the attribution showed they were
    // NEGLIGIBLE here, not the culprit, and there's no reason to loosen them.
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
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
  private model = process.env.GEMINI_CHAT_MODEL ?? "gemini-3-flash-preview";
  // 4-deep fallback chain (PRD-MODEL-FALLBACK, owner decision 2026-07-11):
  // capacity refusals and retired model ids walk down the chain; anything
  // else throws at once. Slightly older code quality for a few minutes >>
  // "Oops! Something went wrong." for every kid.
  // Cross-provider chain (2026-07-20): quality tier first, cheapest within the
  // tier, across every configured provider. Falls back to the Gemini-only
  // ladder when the primary isn't catalogued — an operator can still point
  // GEMINI_CHAT_MODEL at a brand-new Google id and keep working fallback.
  private fallbacks = specFor(this.model)
    ? chainFor({ primary: this.model, tier: specFor(this.model)!.tier, env: process.env })
    : fallbackChain(this.model, process.env);

  // Non-Google generation adapters, keyed by provider. Google stays the native
  // path (buildContents/configFor) — it isn't in here. Each generator owns its
  // SDK/transport + request translation; the runner never sees a provider SDK.
  private generators: Partial<Record<ProviderId, ProviderGenerator>> = {
    openai: new OpenAIGenerator(),
    anthropic: new AnthropicGenerator(),
    moonshot: new MoonshotGenerator(),
  };

  // Per-provider error classifiers (walk-vs-throw + retired-id detection).
  private adapters: Partial<Record<ProviderId, ProviderAdapter>> = {
    openai: openaiAdapter,
    anthropic: anthropicAdapter,
    moonshot: moonshotAdapter,
  };

  /** The non-Google provider serving this slot, or undefined for Google (the
   *  native path). One choke point for every "is this an adapter model?" branch. */
  private nonGoogleProvider(model: string): ProviderId | undefined {
    const p = specFor(model)?.provider;
    return p && p !== "google" ? p : undefined;
  }

  /** Provider-neutral view of the turn, for non-Google adapters. The Gemini
   *  path keeps using buildContents/configFor directly — translating to
   *  GenerationRequest and back would only lose fidelity (thinking budgets,
   *  harm thresholds) that Gemini alone supports. */
  private toGenerationRequest(
    input: { history: ChatMessage[]; message: string; image?: ImageAttachment; forceFullRegen?: boolean; activeGameMessageId?: string },
  ): GenerationRequest {
    const config = this.configFor(input) as { systemInstruction: string; maxOutputTokens?: number };
    return {
      history: input.history.map((m) => ({ role: m.role === "child" ? "child" : "assistant", text: m.text })),
      message: input.message,
      ...(input.image ? { image: { mimeType: input.image.mimeType, data: input.image.data } } : {}),
      systemInstruction: config.systemInstruction,
      maxOutputTokens: config.maxOutputTokens ?? 8192,
    };
  }

  /** Chain policy is per-provider: "overloaded" is a 503 on Google, a 429 with
   *  two opposite meanings on OpenAI, a 529 on Anthropic. Route to the slot's
   *  adapter, or the Google classifier when it's a native Gemini slot. */
  private chainPolicy = {
    shouldTryNextModel: (model: string, err: unknown) => {
      const p = this.nonGoogleProvider(model);
      return p ? this.adapters[p]!.shouldTryNextModel(err) : shouldTryNextModel(err);
    },
    isModelGone: (model: string, err: unknown) => {
      const p = this.nonGoogleProvider(model);
      return p ? this.adapters[p]!.isModelGone(err) : isModelGone(err);
    },
  };

  private buildContents(input: { history: ChatMessage[]; message: string; image?: ImageAttachment }) {
    return buildChatContents(input);
  }

  /** Same fallback-chain resilience replyStream() has, for a ONE-SHOT call
   *  (reply()/repair()): the primary keeps its own retry count, each
   *  fallback gets ONE attempt, and shouldTryNextModel decides whether a
   *  failure walks the chain or throws immediately. BUG-FIX-LOG 2026-07-18:
   *  before this, reply()/repair() called `this.model` directly with no
   *  recovery — so the "patch didn't match → full regeneration" safety net
   *  and self-healing repair both dead-ended on exactly the failures
   *  replyStream() already survives (a retired/misconfigured model id, a
   *  transient outage), even though the main streamed answer recovered fine. */
  private async oneShotWithFallback(
    label: string,
    primaryRetries: number,
    /** The GOOGLE path for a slot, already normalized to `{ text, usage }`. */
    googleCall: (model: string) => Promise<OneShotResult>,
    /** The provider-neutral request a NON-Google slot is served with. Cross-
     *  provider one-shot (E, 2026-07-20): OpenAI slots go through
     *  OpenAIGenerator.generateOnce (moderated), Claude/Kimi through their
     *  generators — the same dispatch the streaming path already uses. */
    req: GenerationRequest,
    /** Defaults to the ordinary chat deadline. A whole-game regeneration must
     *  pass BUILD_TIMEOUT_MS or it cannot finish (BUG-FIX-LOG 2026-07-20). */
    timeoutMs: number = CHAT_TIMEOUT_MS,
    /** Per-request decision-ledger sink (owner ask 2026-07-21) — records every
     *  concurrent call this one-shot fan-out made + the winner. */
    onLedger?: (summary: ChainSummary) => void,
    /** LOSING-call cost sink (owner ask 2026-07-21). A one-shot backup that
     *  finished after the winner is real, already-paid work: this fires with
     *  its model + real billed usage (+ its text, so the route can estimate if
     *  the provider reported no usage) so the route bills it as fallback cost. */
    onLoserCost?: (model: string, usage: TokenUsage | undefined, outputText: string) => void,
  ): Promise<OneShotResult> {
    // Shallow ON PURPOSE — see ONESHOT_MAX_MODELS. Depth here multiplies the
    // child's wait, unlike the streaming path where the hedge races rather
    // than queues. Non-Google slots are NO LONGER filtered out (E): they're
    // dispatched to their generator below, so a rescue can cross providers.
    const chain = [this.model, ...this.fallbacks].slice(0, ONESHOT_MAX_MODELS);
    return runOneShotChain<OneShotResult>({
      chain,
      totalBudgetMs: oneShotBudgetMs(),
      label,
      primaryRetries,
      // NO withTimeout here any more: the deadline belongs to the chain, which
      // uses it to START A BACKUP rather than to kill this attempt. Wrapping a
      // timeout here again would restore the exact discard-then-degrade
      // behaviour that served children the weakest model's answer.
      call: (model, retries) =>
        withRetry(() => {
          const provider = this.nonGoogleProvider(model);
          return provider ? this.generators[provider]!.generateOnce(model, req) : googleCall(model);
        }, { label, retries }),
      slotDeadlineMs: timeoutMs,
      ...this.chainPolicy,
      onLedger,
      // Map the losing attempt's settled OneShotResult → its billed usage. Only
      // value-bearing settlements are billed; an errored backup produced no
      // usable completion, so there's nothing to charge.
      onLoserResult: onLoserCost
        ? (model, result) => { if (result.value) onLoserCost(model, result.value.usage, result.value.text); }
        : undefined,
    });
  }

  /** Normalizes a Google generateContent response to the same `{ text, usage }`
   *  a non-Google generateOnce returns, so one-shot callers never branch. */
  private normalizeGoogle(res: { text?: string; usageMetadata?: GenUsageMetadata }): OneShotResult {
    return { text: res.text ?? "", usage: res.usageMetadata ? usageChunk(res.usageMetadata).usage : undefined };
  }

  /** Fast chat config, or the builder overrides when this turn builds a game.
   *  `forceFullRegen` (api/chat/route.ts's patch-fallback path, BUG-FIX-LOG
   *  class fix 2026-07-18): when a patch attempt fails to apply, the fallback
   *  regeneration call must NOT get the edit-patch instruction again — it
   *  needs a full file back this time. */
  private configFor(input: { history: ChatMessage[]; message: string; forceFullRegen?: boolean; activeGameMessageId?: string }) {
    if (!isGameBuildTurn(input.message, input.history)) return GEN_CONFIG;
    // paid: false until entitlement lands (TECH_DEBT #11) — then this becomes
    // the real per-user entitlement and the paid tier goes always-on (§9).
    const gates = catalogGates({ message: input.message, history: input.history, paid: false });
    const wantsMultiplayer = multiplayerGate({ message: input.message, history: input.history });
    const isEdit = !input.forceFullRegen && isGameEditTurn(input.message, input.history, input.activeGameMessageId);
    // Penguin-maze hardening 2026-07-18: an identical re-send means the last
    // reply claimed success without the change appearing — tell the model.
    const repeated = isRepeatedRequest(input.message, input.history);
    console.log(`[gemini] builder mode — thinking on, extended output, catalogs: 3d=${gates.three} audio=${gates.audio} multiplayer=${wantsMultiplayer} edit=${isEdit} repeated=${repeated}`);
    return {
      ...GEN_CONFIG,
      systemInstruction: buildTurnSystemInstruction(gates, { message: input.message, history: input.history }, wantsMultiplayer, isEdit, repeated),
      ...builderGenOverrides(process.env),
    };
  }

  /** One-shot reply (used where streaming isn't needed — e.g. the
   *  patch-fallback regeneration in api/chat/route.ts). Returns the real
   *  billed usage when Gemini reports it, same as repair() below, so a
   *  fallback call's cost is tracked like any other generation. Walks the
   *  same model-fallback chain replyStream() uses (oneShotWithFallback) —
   *  this is the SAFETY NET for a mismatched patch, so it must not itself be
   *  a dead end on a single bad/unavailable model. */
  async reply(input: { history: ChatMessage[]; message: string; image?: ImageAttachment; forceFullRegen?: boolean; onLedger?: (summary: ChainSummary) => void; onLoserCost?: (model: string, usage: TokenUsage | undefined, outputText: string) => void }) {
    const ai = getClient();
    try {
      const res = await this.oneShotWithFallback(
        "gemini.chat",
        2,
        (model) =>
          ai.models
            .generateContent({ model, contents: this.buildContents(input), config: this.configFor(input) })
            .then((r) => this.normalizeGoogle(r)),
        this.toGenerationRequest(input),
        // A patch-fallback regeneration IS a full game build (thinking on,
        // 24576 output tokens). Giving it the 30s chat deadline made it fail
        // on every model, every time — BUG-FIX-LOG 2026-07-20.
        oneShotTimeoutMs(input),
        input.onLedger,
        input.onLoserCost,
      );
      return { ...extractArtifact(res.text), usage: res.usage };
    } catch (err) {
      throw new GeminiError(`chat generation failed: ${(err as Error).message}`);
    }
  }

  /** ONE hunks-only retry after the model answered an edit turn with a full
   *  rewrite (penguin-maze hardening 2026-07-18). Same shape as repair():
   *  one-shot, raw text back (the route runs applyPatch on it), tight output
   *  cap — a patch is small, and this call only exists because the model
   *  disobeyed the patch contract once already. Child-safety base prompt
   *  stays: an edit can introduce new visible content. Walks the same
   *  model-fallback chain as every other call. */
  async strictEditRetry(input: { currentHtml: string; message: string; onLedger?: (summary: ChainSummary) => void; onLoserCost?: (model: string, usage: TokenUsage | undefined, outputText: string) => void }): Promise<{ text: string; usage?: TokenUsage }> {
    const ai = getClient();
    const composed = `Current game source:\n${input.currentHtml}\n\nThe child asked: ${input.message}`;
    const systemInstruction = `${CHILD_SYSTEM_PROMPT}\n\n${GAME_EDIT_STRICT_RETRY_SECTION}`;
    try {
      const res = await this.oneShotWithFallback(
        "gemini.strict-edit",
        1,
        (model) =>
          ai.models
            .generateContent({
              model,
              contents: [{ role: "user", parts: [{ text: composed }] }],
              config: { ...GEN_CONFIG, systemInstruction, maxOutputTokens: 4096 },
            })
            .then((r) => this.normalizeGoogle(r)),
        { history: [], message: composed, systemInstruction, maxOutputTokens: 4096 },
        CHAT_TIMEOUT_MS,
        input.onLedger,
        input.onLoserCost,
      );
      return { text: res.text, usage: res.usage };
    } catch (err) {
      throw new GeminiError(`strict edit retry failed: ${(err as Error).message}`);
    }
  }

  /**
   * One-shot repair call (self-healing preview, PRD §7). Same model as
   * generation — repair needs the same code competence (§9) — but its own
   * system prompt (minimal-patch contract) and tighter output headroom:
   * a patch is ~8 lines, and output tokens dominate repair latency (§7.1).
   * Walks the same model-fallback chain replyStream()/reply() use — a repair
   * call failing outright on a bad/unavailable model must not cost the kid
   * the auto-heal (BUG-FIX-LOG 2026-07-18).
   */
  async repair(input: { systemPrompt: string; prompt: string; onLedger?: (summary: ChainSummary) => void }): Promise<{ text: string; usage?: TokenUsage }> {
    const ai = getClient();
    try {
      const res = await this.oneShotWithFallback(
        "gemini.repair",
        1,
        (model) =>
          ai.models
            .generateContent({
              model,
              contents: [{ role: "user", parts: [{ text: input.prompt }] }],
              config: { ...GEN_CONFIG, systemInstruction: input.systemPrompt, maxOutputTokens: 4096 },
            })
            .then((r) => this.normalizeGoogle(r)),
        { history: [], message: input.prompt, systemInstruction: input.systemPrompt, maxOutputTokens: 4096 },
        CHAT_TIMEOUT_MS,
        input.onLedger,
      );
      return { text: res.text, usage: res.usage };
    } catch (err) {
      throw new GeminiError(`repair generation failed: ${(err as Error).message}`);
    }
  }

  /** Streaming reply — yields answer deltas AND thought summaries as they're
   *  generated. Thought parts (part.thought, includeThoughts in builder mode)
   *  become the kid-facing planning line; they are NOT part of the answer. */
  async *replyStream(input: { history: ChatMessage[]; message: string; image?: ImageAttachment; activeGameMessageId?: string; forceRebuild?: boolean; preferAlternateModel?: boolean; onLedger?: (summary: ChainSummary) => void }): AsyncGenerator<StreamChunk> {
    const ai = getClient();
    // "🔄 Different one" (PRD-INSTANT-ALTERNATE, on-demand option): lead the
    // chain with the FALLBACK model so the regeneration is a genuinely different
    // model's take, not the same primary re-rolled. Falls back to normal order
    // when there is no fallback configured (still non-deterministically
    // different). The fallbacks are already safety/key-gated (chainFor), so this
    // can never smuggle a prompt-only model past the gate.
    const chain =
      input.preferAlternateModel && this.fallbacks.length > 0
        ? [...this.fallbacks, this.model]
        : [this.model, ...this.fallbacks];
    // The hedged-race chain walk now lives in model-runner.ts so a non-Google
    // adapter can be dropped in without re-implementing it (cross-provider
    // refactor 2026-07-20). Behaviour is unchanged — gemini.fallback.test.ts
    // F.1-F.7 pins it. Gemini specifics stay HERE: how a stream is opened,
    // and how its chunk shape normalizes into ProviderChunk.
    yield* runStreamChain({
      chain,
      openStream: async (model, retries, opts) => {
        // Non-Google slots hand off to their generator, which owns request
        // translation + the SDK/transport. OpenAI additionally moderates
        // (option A); Anthropic/Moonshot are prompt-only and stream directly.
        const provider = this.nonGoogleProvider(model);
        if (provider) return this.generators[provider]!.openStream(model, this.toGenerationRequest({ ...input, forceFullRegen: input.forceRebuild }));
        // forceRebuild ("Change this one" after a new-game prompt, PRD §11):
        // suppress the edit/new-game prompt clause so the model builds the new
        // game fresh in place rather than re-asking or trying to patch.
        const config = this.configFor({ ...input, forceFullRegen: input.forceRebuild });
        // MAX_TOKENS one-shot retry (KNOWN_BUGS #4): the thinking budget ate the
        // whole output allowance last time — halve it so the answer gets room.
        const finalConfig = opts?.reducedThinkingBudget ? withReducedThinkingBudget(config) : config;
        return toProviderChunks(
          await withRetry(
            () => ai.models.generateContentStream({
              model,
              contents: this.buildContents(input),
              config: finalConfig,
            }),
            { label: "gemini.chat.stream", retries },
          ),
        );
      },
      ...this.chainPolicy,
      stallMs: Number(process.env.GEMINI_STALL_SWITCH_MS) || STALL_SWITCH_MS,
      wrapError: (err) => new GeminiError(`chat stream failed: ${(err as Error).message}`),
      onLedger: input.onLedger,
    });
  }
}
