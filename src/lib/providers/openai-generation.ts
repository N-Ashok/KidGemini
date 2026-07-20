// OpenAI generation for the cross-provider fallback chain (owner decision
// 2026-07-20, option A). Translates a GenerationRequest into OpenAI's request
// shape and its SSE stream back into ProviderChunks.
//
// ── The one design decision worth arguing about ──────────────────────────────
// This adapter BUFFERS the whole answer, moderates it, and only then emits it.
// That gives up token-by-token streaming on OpenAI turns, which is a real UX
// cost, so the reasoning matters:
//
//   On Gemini the safety thresholds are enforced by the generation call
//   itself — unsafe text never exists to be streamed. OpenAI has no
//   per-request equivalent, so the only honest way to keep the same guarantee
//   is to judge the finished answer before the child sees any of it. Streaming
//   first and retracting later is not an option: the child has already read
//   it, and "games are never blocked or retracted" (CLAUDE.md §3) exists
//   precisely because retraction is a terrible experience.
//
// The cost lands only on the RESCUE path (Google unavailable), where the PRD
// already accepts degraded quality, and the kid sees a slightly longer
// "thinking" pause rather than a progressive answer. If that pause proves too
// long on real turns, the fix is a faster model in the chain — not streaming
// unmoderated text.

import "server-only";
import type { GenerationRequest, NormalizedUsage } from "@/types/model-provider.types";
import type { SafetyClassifier } from "@/types/safety.types";
import type { ProviderChunk } from "../model-runner";
import { OpenAIModerationClassifier } from "./openai-moderation";

/** A safety VERDICT. Distinct type so the chain classifier can refuse to walk
 *  past it — retrying a block on another model is shopping for a yes. */
export class ModerationBlockedError extends Error {
  constructor(reason: string) {
    super(`moderation blocked: ${reason}`);
    this.name = "ModerationBlockedError";
  }
}

/** The OpenAI SSE chunk fields we read. */
interface SseChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

type CreateStream = (model: string, body: Record<string, unknown>) => Promise<AsyncIterable<SseChunk>>;

type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
};

/** GenerationRequest → OpenAI messages. Exported for the test that pins it. */
export function buildMessages(req: GenerationRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: "system", content: req.systemInstruction }];
  for (const m of req.history) {
    messages.push({ role: m.role === "child" ? "user" : "assistant", content: m.text });
  }
  // The picture rides on the FINAL user turn only — history never carries
  // images (they aren't persisted; single-turn context by design, matching
  // buildChatContents in gemini.ts).
  messages.push(
    req.image
      ? {
          role: "user",
          content: [
            { type: "text", text: req.message },
            { type: "image_url", image_url: { url: `data:${req.image.mimeType};base64,${req.image.data}` } },
          ],
        }
      : { role: "user", content: req.message },
  );
  return messages;
}

function toUsage(u: SseChunk["usage"]): NormalizedUsage | undefined {
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    // Reasoning tokens bill at the output rate, same as Gemini's thoughts.
    thoughtTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    // OpenAI reports cached as a SUBSET of prompt_tokens, matching our
    // TokenUsage contract (see chat.types.ts).
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

export class OpenAIGenerator {
  private readonly createStream: CreateStream;
  private readonly moderator: SafetyClassifier;
  private readonly env: Record<string, string | undefined>;

  constructor(deps: {
    createStream?: CreateStream;
    moderator?: SafetyClassifier;
    env?: Record<string, string | undefined>;
  } = {}) {
    this.env = deps.env ?? process.env;
    this.moderator = deps.moderator ?? new OpenAIModerationClassifier({ env: this.env });
    this.createStream = deps.createStream ?? (async (model, body) => {
      const apiKey = this.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey });
      return (await client.chat.completions.create({
        model,
        messages: body.messages as never,
        max_completion_tokens: body.max_completion_tokens as number,
        stream: true,
        // Ask for the billed counts on the final chunk, or the cost dashboard
        // silently falls back to an estimate for every OpenAI turn.
        stream_options: { include_usage: true },
      })) as unknown as AsyncIterable<SseChunk>;
    });
  }

  private async guard(text: string, origin: "child" | "model"): Promise<void> {
    const verdict = await this.moderator.classify({ text, origin });
    if (verdict.action === "hard_block") throw new ModerationBlockedError(verdict.reason);
  }

  /**
   * Stream a turn. Shaped as `openStream(model, req)` so it slots straight into
   * model-runner's `openStream` dep. Emits one text chunk (post-moderation)
   * plus a usage chunk — see the buffering note at the top of this file.
   */
  async openStream(model: string, req: GenerationRequest): Promise<AsyncIterable<ProviderChunk>> {
    // Input gate FIRST: a blocked message must never reach the model, both to
    // honour the verdict and to avoid paying for a generation we'd discard.
    await this.guard(req.message, "child");

    const stream = await this.createStream(model, {
      messages: buildMessages(req),
      max_completion_tokens: req.maxOutputTokens,
    });

    const self = this;
    return (async function* (): AsyncGenerator<ProviderChunk> {
      let text = "";
      let usage: NormalizedUsage | undefined;
      for await (const chunk of stream) {
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) text += piece;
        const u = toUsage(chunk.usage);
        if (u) usage = u;
      }
      // Output gate — nothing above this line was yielded.
      await self.guard(text, "model");
      if (text) yield { text };
      if (usage) yield { usage };
    })();
  }

  /** One-shot equivalent (reply/repair/strictEditRetry paths). Same gates. */
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
