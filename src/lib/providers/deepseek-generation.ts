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
// DeepSeek-specific vs Moonshot: `deepseek-reasoner` streams chain-of-thought in
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
      return (await client.chat.completions.create({
        model,
        messages: body.messages as never,
        max_completion_tokens: body.max_completion_tokens as number,
        stream: true,
        stream_options: { include_usage: true },
      })) as unknown as AsyncIterable<SseChunk>;
    });
  }

  async openStream(model: string, req: GenerationRequest): Promise<AsyncIterable<ProviderChunk>> {
    const stream = await this.createStream(model, {
      messages: buildMessages(req),
      max_completion_tokens: req.maxOutputTokens,
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
