// Anthropic generation: GenerationRequest → Messages body (system is TOP-LEVEL,
// the one shape difference from OpenAI), and the SSE event stream → ProviderChunks
// with normalized finishReason + usage. Transport is injected — no network.
import { describe, expect, it } from "vitest";
import { AnthropicGenerator, buildAnthropicBody } from "./anthropic-generation";
import type { GenerationRequest } from "@/types/model-provider.types";

const REQ: GenerationRequest = {
  history: [
    { role: "child", text: "make a racing game" },
    { role: "assistant", text: "Here!" },
  ],
  message: "make it faster",
  systemInstruction: "You are a friendly assistant for a child.",
  maxOutputTokens: 4096,
};

/** A fake Anthropic SSE event stream. */
async function* events(...evs: Array<Record<string, unknown>>) {
  for (const e of evs) yield e as never;
}

const gen = (evs: Array<Record<string, unknown>>) =>
  new AnthropicGenerator({ createStream: async () => events(...evs), env: { ANTHROPIC_API_KEY: "k" } });

async function collect(g: AnthropicGenerator) {
  const out: { text?: string; usage?: unknown; finishReason?: string }[] = [];
  for await (const c of await g.openStream("claude-sonnet-5", REQ)) out.push(c);
  return out;
}

describe("buildAnthropicBody", () => {
  it("AG.1 puts the system prompt at the TOP LEVEL, not in messages", () => {
    const body = buildAnthropicBody(REQ);
    expect(body.system).toBe(REQ.systemInstruction);
    expect((body.messages as unknown[])).toHaveLength(3); // 2 history + final user
    expect((body.messages as Array<{ role: string }>).every((m) => m.role !== "system")).toBe(true);
    expect(body.max_tokens).toBe(4096);
  });

  it("AG.2 maps child→user / assistant→assistant, final message is the new user turn", () => {
    const msgs = buildAnthropicBody(REQ).messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[2]).toEqual({ role: "user", content: "make it faster" });
  });

  it("AG.3 an image rides as a base64 image block on the final user turn", () => {
    const body = buildAnthropicBody({ ...REQ, image: { mimeType: "image/png", data: "AAAA" } });
    const last = (body.messages as Array<{ content: unknown }>).at(-1)!.content as Array<{ type: string }>;
    expect(last.map((b) => b.type)).toEqual(["text", "image"]);
  });
});

describe("AnthropicGenerator.openStream", () => {
  it("AG.4 streams text deltas token-by-token (prompt-only → no buffering)", async () => {
    const out = await collect(
      gen([
        { type: "content_block_delta", delta: { type: "text_delta", text: "Zoom " } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "zoom!" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      ]),
    );
    const text = out.filter((c) => c.text).map((c) => c.text).join("");
    expect(text).toBe("Zoom zoom!");
    // two separate delta chunks — proof it did not buffer into one
    expect(out.filter((c) => c.text)).toHaveLength(2);
  });

  it("AG.5 surfaces usage (input from message_start, output from message_delta) and a stop finishReason", async () => {
    const out = await collect(
      gen([
        { type: "message_start", message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
      ]),
    );
    const final = out.at(-1)!;
    expect(final.usage).toMatchObject({ promptTokens: 50, outputTokens: 7, cachedTokens: 10 });
    expect(final.finishReason).toBe("stop");
  });

  it("AG.6 a refusal stop_reason normalizes to 'safety' (fails closed at the runner)", async () => {
    const out = await collect(
      gen([{ type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } }]),
    );
    expect(out.at(-1)!.finishReason).toBe("safety");
  });

  it("AG.7 max_tokens stop_reason normalizes to 'max_tokens' (runner retries once)", async () => {
    const out = await collect(
      gen([{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } }]),
    );
    expect(out.at(-1)!.finishReason).toBe("max_tokens");
  });

  it("AG.8 generateOnce concatenates the streamed text", async () => {
    const g = gen([
      { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    ]);
    expect((await g.generateOnce("claude-sonnet-5", REQ)).text).toBe("ab");
  });
});
