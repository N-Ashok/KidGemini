// Moonshot (Kimi) generation: OpenAI-compatible SSE → ProviderChunks, streaming
// directly (prompt-only → no moderation buffer), with normalized finishReason +
// usage. Transport injected — no network. Shares buildMessages with OpenAI.
import { describe, expect, it } from "vitest";
import { MoonshotGenerator } from "./moonshot-generation";
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
  new MoonshotGenerator({ createStream: async () => sse(...chunks), env: { MOONSHOT_API_KEY: "k" } });

async function collect(g: MoonshotGenerator) {
  const out: { text?: string; usage?: unknown; finishReason?: string }[] = [];
  for await (const c of await g.openStream("kimi-k2", REQ)) out.push(c);
  return out;
}

describe("MoonshotGenerator.openStream", () => {
  it("MG.1 streams delta content token-by-token (no buffering)", async () => {
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

  it("MG.2 surfaces usage and a 'stop' finishReason on the terminal chunk", async () => {
    const out = await collect(
      gen([
        { choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 8 } } },
      ]),
    );
    const final = out.at(-1)!;
    expect(final.usage).toMatchObject({ promptTokens: 20, outputTokens: 5, cachedTokens: 8 });
    expect(final.finishReason).toBe("stop");
  });

  it("MG.3 content_filter → 'safety', length → 'max_tokens'", async () => {
    const blocked = await collect(gen([{ choices: [{ delta: {}, finish_reason: "content_filter" }] }]));
    expect(blocked.at(-1)!.finishReason).toBe("safety");
    const truncated = await collect(gen([{ choices: [{ delta: {}, finish_reason: "length" }] }]));
    expect(truncated.at(-1)!.finishReason).toBe("max_tokens");
  });

  it("MG.4 generateOnce concatenates the streamed text", async () => {
    const g = gen([
      { choices: [{ delta: { content: "x" } }] },
      { choices: [{ delta: { content: "y" }, finish_reason: "stop" }] },
    ]);
    expect((await g.generateOnce("kimi-k2", REQ)).text).toBe("xy");
  });
});
