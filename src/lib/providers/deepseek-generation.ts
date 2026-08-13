// DeepSeek generation for the cross-provider fallback chain (owner ask
// 2026-08-12: "make deepseek functional in the fallback"). DeepSeek exposes an
// OpenAI-COMPATIBLE API, so this reuses the openai SDK with a different base URL
// and the same message/SSE shape (buildMessages is shared from
// openai-generation.ts) — the same arrangement as Moonshot.
//
// Like MoonshotGenerator and unlike OpenAIGenerator this does NOT
// buffer-and-moderate: DeepSeek is a `prompt-only` model here (no moderation
// endpoint to front it with), so it streams token-by-token and only ever runs
// behind the ALLOW_PROMPT_ONLY_SAFETY_MODELS + DEEPSEEK_API_KEY gate.
//
// DATA-HANDLING NOTE: DeepSeek is a China-based provider, the same
// consideration recorded for Moonshot. Beyond the prompt-only gate, keep it off
// (unset DEEPSEEK_API_KEY) until a privacy/compliance review of sending a
// child's prompts there — see model-registry.ts and docs/DATA_HANDLING.md.
//
// DeepSeek-specific vs Moonshot: DeepSeek's reasoning models stream chain-of-thought in
// a separate `reasoning_content` delta field, and reports cache hits under
// prompt_cache_hit_tokens rather than prompt_tokens_details.cached_tokens.
// Both are handled below; getting the first wrong would print the model's
// private reasoning into a child's chat.

import "server-only";
import type { GenerationRequest, NormalizedUsage } from "@/types/model-provider.types";
import type { FinishReason, ProviderChunk, ProviderGenerator } from "../model-runner";
import { buildMessages } from "./openai-generation";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/** OpenAI-shaped SSE chunk fields, plus DeepSeek's reasoning extensions. */
interface SseChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    /** DeepSeek's cache-hit counter (OpenAI puts this in prompt_tokens_details). */
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

type CreateStream = (model: string, body: Record<string, unknown>) => Promise<AsyncIterable<SseChunk>>;

/** OpenAI/DeepSeek finish_reason → the runner's normalized finishReason. */
function normalizeFinish(raw?: string | null): FinishReason | undefined {
  if (!raw) return undefined;
  if (raw === "content_filter") return "safety";
  if (raw === "length") return "max_tokens";
  if (raw === "stop") return "stop";
  return "other";
}

function toUsage(u: SseChunk["usage"]): NormalizedUsage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    // Reasoner tokens are billed as output but are not visible answer text —
    // reported separately so the cost dashboard shows where the money went.
    thoughtTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/** DeepSeek's own effort ladder. `medium`/`xhigh` are documented as aliases onto
 *  these, so they are deliberately NOT accepted — an operator who types one
 *  should see it ignored rather than silently resolve to something else.
 *  NOTE: v4-flash supports all three; v4-pro currently accepts only high/max. */
const EFFORTS = new Set(["low", "high", "max"]);

/**
 * Thinking controls — the ONLY lever DeepSeek gives us, and the reason it
 * matters: on the 2026-08-12 rocket build turn v4-flash spent 45,411 of 53,530
 * output tokens (85%) thinking, which is what put a 24KB game 5.9x over
 * BUILD_TIMEOUT_MS. Gemini solves the same problem with `thinkingBudget`
 * (builder-mode.ts); DeepSeek exposes `reasoning_effort` and an on/off switch
 * instead, so those are what we expose.
 *
 * Both default to UNSET — no field is sent, the provider default (effort
 * "high") stands, and behaviour is identical to before this existed. A junk
 * value is dropped rather than forwarded: an unknown enum is a 400, and the
 * chain classifies 400s as real defects that throw instead of walking, so a
 * typo'd env var could otherwise dead-end a child's turn.
 */
export function thinkingControls(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const effort = env.DEEPSEEK_REASONING_EFFORT?.trim().toLowerCase();
  if (effort && EFFORTS.has(effort)) out.reasoning_effort = effort;
  const thinking = env.DEEPSEEK_THINKING?.trim().toLowerCase();
  if (thinking === "disabled" || thinking === "enabled") out.thinking = { type: thinking };

  // Temperature rides ONLY in non-thinking mode. DeepSeek documents that
  // thinking mode does not support temperature/top_p/penalties, so sending it
  // alongside thinking would be a 400 — which the chain treats as a real defect
  // and throws on rather than walking. Their own guidance is 0.2 for code.
  // `Number("")` is 0 — a perfectly valid temperature — so an unset/blank var
  // would otherwise pin the model to fully deterministic sampling by accident.
  const rawTemp = env.DEEPSEEK_TEMPERATURE?.trim();
  const temp = rawTemp ? Number(rawTemp) : NaN;
  if (out.thinking && (out.thinking as { type: string }).type === "disabled" && Number.isFinite(temp) && temp >= 0 && temp <= 2) {
    out.temperature = temp;
  }
  return out;
}

export class DeepSeekGenerator implements ProviderGenerator {
  private readonly createStream: CreateStream;
  private readonly env: Record<string, string | undefined>;

  constructor(deps: { createStream?: CreateStream; env?: Record<string, string | undefined> } = {}) {
    this.env = deps.env ?? process.env;
    this.createStream = deps.createStream ?? (async (model, body) => {
      const apiKey = this.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey, baseURL: this.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL });
      const { messages, max_completion_tokens, ...extra } = body;
      return (await client.chat.completions.create({
        model,
        messages: messages as never,
        max_completion_tokens: max_completion_tokens as number,
        stream: true,
        stream_options: { include_usage: true },
        // reasoning_effort / thinking — DeepSeek extensions the OpenAI SDK's
        // types don't know about, forwarded verbatim.
        ...extra,
      } as never)) as unknown as AsyncIterable<SseChunk>;
    });
  }

  async openStream(model: string, req: GenerationRequest): Promise<AsyncIterable<ProviderChunk>> {
    const stream = await this.createStream(model, {
      messages: buildMessages(req),
      max_completion_tokens: req.maxOutputTokens,
      ...thinkingControls(this.env),
    });
    return (async function* (): AsyncGenerator<ProviderChunk> {
      let usage: NormalizedUsage | undefined;
      let finishReason: FinishReason | undefined;
      for await (const chunk of stream) {
        // `reasoning_content` is deliberately NOT read: it is the model's
        // private chain-of-thought, not answer text (DS.2).
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) yield { text: piece };
        const u = toUsage(chunk.usage);
        if (u) usage = u;
        const fin = normalizeFinish(chunk.choices?.[0]?.finish_reason);
        if (fin) finishReason = fin;
      }
      if (usage || finishReason) yield { ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) };
    })();
  }

  async generateOnce(model: string, req: GenerationRequest): Promise<{ text: string; usage?: NormalizedUsage }> {
    let text = "";
    let usage: NormalizedUsage | undefined;
    for await (const c of await this.openStream(model, req)) {
      if (c.text) text += c.text;
      if (c.usage) usage = c.usage;
    }
    return { text, usage };
  }
}
