// Pins the OpenAI generation path (owner decision 2026-07-20, option A).
//
// The load-bearing behaviour is ORDERING, not translation: on Gemini the
// safety thresholds are enforced by the generation call itself, so there is no
// window in which unsafe text exists. OpenAI has no such knob, so this adapter
// has to create that guarantee itself — moderate the child's message before
// the model sees it, and moderate the answer before the child sees it.
import { describe, expect, it, vi } from "vitest";
import { OpenAIGenerator, ModerationBlockedError } from "./openai-generation";
import { openaiAdapter } from "./openai-adapter";
import type { GenerationRequest } from "@/types/model-provider.types";
import type { SafetyClassifier, SafetyVerdict } from "@/types/safety.types";

const allow: SafetyClassifier = { classify: async () => ({ action: "allow", category: null, severity: "low", reason: "" }) };
const block = (reason = "nope"): SafetyClassifier => ({
  classify: async (): Promise<SafetyVerdict> => ({ action: "hard_block", category: "sexual", severity: "high", reason }),
});
/** Blocks only when judging the MODEL's output, not the child's input. */
const blockOutputOnly: SafetyClassifier = {
  classify: async ({ origin }) =>
    origin === "model"
      ? { action: "hard_block", category: "violence", severity: "high", reason: "bad output" }
      : { action: "allow", category: null, severity: "low", reason: "" },
};

const req: GenerationRequest = {
  history: [{ role: "child", text: "hi" }, { role: "assistant", text: "hello!" }],
  message: "make me a game",
  systemInstruction: "SYSTEM",
  maxOutputTokens: 2048,
};

/** Fake OpenAI SSE stream: text deltas, then a usage-only final chunk. */
async function* fakeSse(text: string) {
  for (const piece of text.match(/.{1,4}/g) ?? []) {
    yield { choices: [{ delta: { content: piece } }] };
  }
  yield {
    choices: [{ delta: {} }],
    usage: {
      prompt_tokens: 100, completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 60 },
      completion_tokens_details: { reasoning_tokens: 7 },
    },
  };
}

const gen = (opts: { stream?: unknown; moderator?: SafetyClassifier } = {}) =>
  new OpenAIGenerator({
    createStream: (opts.stream as never) ?? (async () => fakeSse("Here is your game")),
    moderator: opts.moderator ?? allow,
    env: { OPENAI_API_KEY: "sk-test" },
  });

async function drain(g: AsyncIterable<{ text?: string; usage?: unknown }>) {
  const out = [];
  for await (const c of g) out.push(c);
  return out;
}

describe("request translation", () => {
  it("G.1 system instruction, history and the new message become OpenAI messages", async () => {
    const createStream = vi.fn(async (_model: string, _body: Record<string, unknown>) => fakeSse("ok"));
    await drain(await gen({ stream: createStream }).openStream("gpt-5.4-mini", req));
    const body = createStream.mock.calls[0]![1] as unknown as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(body.messages[2]).toEqual({ role: "assistant", content: "hello!" });
    expect(body.messages[3]!.role).toBe("user");
  });

  it("G.2 an attached image rides on the FINAL user turn as a data URL, never in history", async () => {
    const createStream = vi.fn(async (_model: string, _body: Record<string, unknown>) => fakeSse("ok"));
    await drain(await gen({ stream: createStream }).openStream("gpt-5.4-mini", {
      ...req, image: { mimeType: "image/png", data: "AAAA" },
    }));
    const body = createStream.mock.calls[0]![1] as unknown as { messages: Array<{ content: unknown }> };
    const last = body.messages[body.messages.length - 1]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(last)).toBe(true);
    expect(last.some((p) => p.type === "image_url")).toBe(true);
    // History entries stay plain strings — images are single-turn by design.
    expect(typeof (body.messages[1] as { content: unknown }).content).toBe("string");
  });
});

describe("moderation ordering — the option-A guarantee", () => {
  it("G.3 a blocked CHILD message never reaches the model at all", async () => {
    const createStream = vi.fn(async (_model: string, _body: Record<string, unknown>) => fakeSse("should never run"));
    // openStream() rejects EAGERLY — before returning an iterable at all —
    // which is what guarantees no request is issued. If this ever became lazy
    // (thrown on first iteration instead), a caller that opens a stream and
    // abandons it would still have paid for, and sent, a blocked message.
    await expect(
      gen({ stream: createStream, moderator: block() }).openStream("gpt-5.4-mini", req),
    ).rejects.toBeInstanceOf(ModerationBlockedError);
    expect(createStream).not.toHaveBeenCalled();
  });

  it("G.4 unsafe model output is never emitted to the child", async () => {
    const chunks = drain(await gen({ moderator: blockOutputOnly }).openStream("gpt-5.4-mini", req));
    await expect(chunks).rejects.toBeInstanceOf(ModerationBlockedError);
  });

  it("G.5 output is BUFFERED — nothing is yielded before the answer has been judged", async () => {
    // If any delta escaped early, the child would have already seen text that
    // moderation then rejects — un-sendable. Streaming smoothness is traded
    // for that guarantee on this (rescue-only) path.
    let emittedBeforeVerdict = 0;
    const moderator: SafetyClassifier = {
      classify: async ({ origin }) => {
        if (origin === "model") emittedBeforeVerdict = seen;
        return { action: "allow", category: null, severity: "low", reason: "" };
      },
    };
    let seen = 0;
    const g = gen({ moderator }).openStream("gpt-5.4-mini", req);
    for await (const _c of await g) seen++;
    expect(emittedBeforeVerdict).toBe(0);
    expect(seen).toBeGreaterThan(0); // …and it does eventually emit
  });

  it("G.6 a moderation block must NOT walk the chain — it is a verdict, not an outage", () => {
    expect(openaiAdapter.shouldTryNextModel(new ModerationBlockedError("blocked"))).toBe(false);
  });
});

describe("clean path", () => {
  it("G.7 emits the full answer and a usage chunk", async () => {
    const out = await drain(await gen().openStream("gpt-5.4-mini", req));
    expect(out.map((c) => c.text).join("")).toBe("Here is your game");
    expect(out.some((c) => c.usage)).toBe(true);
  });

  it("G.8 maps OpenAI usage onto our billed-token vocabulary, reasoning included", async () => {
    const out = await drain(await gen().openStream("gpt-5.4-mini", req));
    const usage = out.find((c) => c.usage)!.usage as Record<string, number>;
    expect(usage).toEqual({ promptTokens: 100, outputTokens: 40, thoughtTokens: 7, cachedTokens: 60 });
  });
});
