// Anthropic (Claude) generation for the cross-provider fallback chain (owner
// decision 2026-07-20). Uses fetch + SSE directly — NO SDK dependency — so the
// package surface stays small and the transport is trivially injectable for
// tests. Streams token-by-token: Claude is a `prompt-only` model here (no output
// moderation pass), so unlike the OpenAI adapter it does not buffer — the
// child-safety floor for it is the input rules + system prompt, and it only ever
// runs behind the ALLOW_PROMPT_ONLY_SAFETY_MODELS + ANTHROPIC_API_KEY gate.

import "server-only";
import type { GenerationRequest, NormalizedUsage } from "@/types/model-provider.types";
import type { FinishReason, ProviderChunk, ProviderGenerator } from "../model-runner";

const ANTHROPIC_VERSION = "2023-06-01";

/** The SSE event shapes we read (Anthropic Messages streaming). */
interface AnthropicEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  message?: { usage?: AnthropicUsage; stop_reason?: string };
  usage?: AnthropicUsage;
}
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

type CreateStream = (model: string, body: Record<string, unknown>) => Promise<AsyncIterable<AnthropicEvent>>;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
};

/** GenerationRequest → Anthropic request body. System is a TOP-LEVEL field
 *  (not a message), which is the one shape difference from OpenAI worth pinning. */
export function buildAnthropicBody(req: GenerationRequest): Record<string, unknown> {
  const messages: AnthropicMessage[] = req.history.map((m) => ({
    role: m.role === "child" ? "user" : "assistant",
    content: m.text,
  }));
  messages.push(
    req.image
      ? {
          role: "user",
          content: [
            { type: "text", text: req.message },
            { type: "image", source: { type: "base64", media_type: req.image.mimeType, data: req.image.data } },
          ],
        }
      : { role: "user", content: req.message },
  );
  return {
    system: req.systemInstruction,
    messages,
    max_tokens: req.maxOutputTokens,
  };
}

/** Claude stop_reason → the runner's normalized finishReason (KNOWN_BUGS #4).
 *  `refusal` is Claude declining on safety grounds → fail closed like SAFETY. */
function normalizeStopReason(raw?: string): FinishReason | undefined {
  if (!raw) return undefined;
  if (raw === "refusal") return "safety";
  if (raw === "max_tokens") return "max_tokens";
  if (raw === "end_turn" || raw === "stop_sequence" || raw === "tool_use") return "stop";
  return "other";
}

function toUsage(u?: AnthropicUsage): NormalizedUsage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    thoughtTokens: 0, // Claude extended thinking, when used, bills within output
    cachedTokens: u.cache_read_input_tokens ?? 0,
  };
}

/** Parses an SSE HTTP response into Anthropic event objects. Non-2xx throws an
 *  error carrying the status + Anthropic error `type`, which anthropic-adapter
 *  reads to decide whether to walk the chain. */
async function* fetchSse(model: string, body: Record<string, unknown>, env: Record<string, string | undefined>): AsyncGenerator<AnthropicEvent> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await fetch(env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model, stream: true, ...body }),
  });
  if (!res.ok || !res.body) {
    let errorType: string | undefined;
    let message = `anthropic ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { type?: string; message?: string } };
      errorType = j.error?.type;
      message = j.error?.message ?? message;
    } catch { /* body already a stream / empty */ }
    throw Object.assign(new Error(message), { status: res.status, errorType });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split("\n")) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data) as AnthropicEvent; } catch { /* keep-alive / partial */ }
      }
    }
  }
}

export class AnthropicGenerator implements ProviderGenerator {
  private readonly createStream: CreateStream;
  private readonly env: Record<string, string | undefined>;

  constructor(deps: { createStream?: CreateStream; env?: Record<string, string | undefined> } = {}) {
    this.env = deps.env ?? process.env;
    this.createStream = deps.createStream ?? ((model, body) => Promise.resolve(fetchSse(model, body, this.env)));
  }

  async openStream(model: string, req: GenerationRequest): Promise<AsyncIterable<ProviderChunk>> {
    const stream = await this.createStream(model, buildAnthropicBody(req));
    return (async function* (): AsyncGenerator<ProviderChunk> {
      let usage: NormalizedUsage | undefined;
      let finishReason: FinishReason | undefined;
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          yield { text: ev.delta.text };
        }
        // input/cached arrive ONCE on message_start; output accumulates on
        // message_delta. Merge per-field, non-zero-wins, so a later event
        // carrying only output can't clobber the prompt/cached from the start.
        const u = toUsage(ev.message?.usage) ?? toUsage(ev.usage);
        if (u) {
          usage = {
            promptTokens: u.promptTokens || usage?.promptTokens || 0,
            outputTokens: u.outputTokens || usage?.outputTokens || 0,
            thoughtTokens: 0,
            cachedTokens: u.cachedTokens || usage?.cachedTokens || 0,
          };
        }
        const stop = normalizeStopReason(ev.delta?.stop_reason ?? ev.message?.stop_reason);
        if (stop) finishReason = stop;
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
