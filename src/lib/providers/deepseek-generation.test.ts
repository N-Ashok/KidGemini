// DeepSeek generation: OpenAI-compatible SSE → ProviderChunks. Transport
// injected — no network. Shares buildMessages with OpenAI.
//
// The DeepSeek-specific risk these cover is `reasoning_content`: deepseek-reasoner
// streams its chain-of-thought in a SEPARATE delta field. Treating it as text
// would print the model's private reasoning straight into a child's chat, and
// would corrupt every artifact by wrapping the game HTML in thinking prose.
import { describe, expect, it } from "vitest";
import { DeepSeekGenerator } from "./deepseek-generation";
import type { GenerationRequest } from "@/types/model-provider.types";

const REQ: GenerationRequest = {
  history: [{ role: "child", text: "make a game" }],
  message: "add a jump",
  systemInstruction: "You are a friendly assistant for a child.",
  maxOutputTokens: 4096,
};

async function* sse(...chunks: Array<Record<string, unknown>>) {
  for (const c of chunks) yield c as never;
}
const gen = (chunks: Array<Record<string, unknown>>) =>
  new DeepSeekGenerator({ createStream: async () => sse(...chunks), env: { DEEPSEEK_API_KEY: "k" } });

async function collect(g: DeepSeekGenerator) {
  const out: { text?: string; usage?: unknown; finishReason?: string }[] = [];
  for await (const c of await g.openStream("deepseek-chat", REQ)) out.push(c);
  return out;
}

describe("DeepSeekGenerator.openStream", () => {
  it("DS.1 streams delta content token-by-token (no buffering)", async () => {
    const out = await collect(
      gen([
        { choices: [{ delta: { content: "Jump " } }] },
        { choices: [{ delta: { content: "added!" }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 20, completion_tokens: 5 } },
      ]),
    );
    expect(out.filter((c) => c.text).map((c) => c.text).join("")).toBe("Jump added!");
    expect(out.filter((c) => c.text)).toHaveLength(2);
  });

  it("DS.2 NEVER emits reasoning_content as text — a kid must not see the model thinking", async () => {
    const out = await collect(
      gen([
        { choices: [{ delta: { reasoning_content: "The child wants a jump. I should..." } }] },
        { choices: [{ delta: { content: "Done!" }, finish_reason: "stop" }] },
      ]),
    );
    expect(out.filter((c) => c.text).map((c) => c.text).join("")).toBe("Done!");
  });

  it("DS.3 counts reasoning tokens as thoughtTokens, not output — the cost line stays honest", async () => {
    const out = await collect(
      gen([
        { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
        {
          usage: {
            prompt_tokens: 20,
            completion_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 25 },
            prompt_cache_hit_tokens: 8,
          },
        },
      ]),
    );
    expect(out.at(-1)!.usage).toMatchObject({
      promptTokens: 20,
      outputTokens: 30,
      thoughtTokens: 25,
      cachedTokens: 8,
    });
  });

  it("DS.4 content_filter → 'safety', length → 'max_tokens'", async () => {
    const blocked = await collect(gen([{ choices: [{ delta: {}, finish_reason: "content_filter" }] }]));
    expect(blocked.at(-1)!.finishReason).toBe("safety");
    const truncated = await collect(gen([{ choices: [{ delta: {}, finish_reason: "length" }] }]));
    expect(truncated.at(-1)!.finishReason).toBe("max_tokens");
  });

  it("DS.5 generateOnce concatenates the streamed text", async () => {
    const g = gen([
      { choices: [{ delta: { content: "x" } }] },
      { choices: [{ delta: { content: "y" }, finish_reason: "stop" }] },
    ]);
    expect((await g.generateOnce("deepseek-chat", REQ)).text).toBe("xy");
  });

  it("DS.6 generateOnce drops reasoning_content too", async () => {
    const g = gen([
      { choices: [{ delta: { reasoning_content: "hmm" } }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
    ]);
    expect((await g.generateOnce("deepseek-reasoner", REQ)).text).toBe("answer");
  });
});
