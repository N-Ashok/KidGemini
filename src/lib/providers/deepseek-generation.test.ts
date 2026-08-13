// DeepSeek generation: OpenAI-compatible SSE → ProviderChunks. Transport
// injected — no network. Shares buildMessages with OpenAI.
//
// The DeepSeek-specific risk these cover is `reasoning_content`: a reasoning model
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
  for await (const c of await g.openStream("deepseek-v4-flash", REQ)) out.push(c);
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
    expect((await g.generateOnce("deepseek-v4-flash", REQ)).text).toBe("xy");
  });

  // Thinking control (2026-08-12). DeepSeek's own measurements on the rocket
  // build turn: v4-flash spent 45,411 of 53,530 output tokens (85%) thinking,
  // which is what put it 5.9x over BUILD_TIMEOUT_MS. Unlike Gemini's
  // thinkingBudget these are the only knobs, so they are the whole lever.
  async function bodyFor(env: Record<string, string | undefined>) {
    let seen: Record<string, unknown> = {};
    const g = new DeepSeekGenerator({
      env: { DEEPSEEK_API_KEY: "k", ...env },
      createStream: async (_m, body) => { seen = body; return sse({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }); },
    });
    for await (const _ of await g.openStream("deepseek-v4-flash", REQ)) { /* drain */ }
    return seen;
  }

  it("DS.7 sends NO thinking fields by default — the provider default is untouched", async () => {
    const body = await bodyFor({});
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });

  it("DS.8 DEEPSEEK_REASONING_EFFORT sets reasoning_effort", async () => {
    expect(await bodyFor({ DEEPSEEK_REASONING_EFFORT: "low" })).toMatchObject({ reasoning_effort: "low" });
  });

  it("DS.9 an invalid effort is DROPPED, never forwarded as a 400", async () => {
    // The chain treats a 400 as a real defect and throws rather than walking,
    // so a typo'd env value must not be able to dead-end a child's turn.
    for (const v of ["", "medium-ish", "LOWEST", "1"]) {
      expect(await bodyFor({ DEEPSEEK_REASONING_EFFORT: v }), v).not.toHaveProperty("reasoning_effort");
    }
  });

  it("DS.10 DEEPSEEK_THINKING=disabled turns thinking off entirely", async () => {
    expect(await bodyFor({ DEEPSEEK_THINKING: "disabled" })).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("DS.11 both knobs can ride together", async () => {
    const body = await bodyFor({ DEEPSEEK_THINKING: "enabled", DEEPSEEK_REASONING_EFFORT: "high" });
    expect(body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
  });

  it("DS.12 temperature rides ONLY with thinking disabled — thinking mode rejects it", async () => {
    // DeepSeek documents that thinking mode does not support temperature; a 400
    // is classified as a real defect and THROWS instead of walking the chain,
    // so this pairing must be impossible to configure by accident.
    expect(await bodyFor({ DEEPSEEK_THINKING: "disabled", DEEPSEEK_TEMPERATURE: "0.2" })).toMatchObject({ temperature: 0.2 });
    expect(await bodyFor({ DEEPSEEK_TEMPERATURE: "0.2" })).not.toHaveProperty("temperature");
    expect(await bodyFor({ DEEPSEEK_THINKING: "enabled", DEEPSEEK_TEMPERATURE: "0.2" })).not.toHaveProperty("temperature");
  });

  it("DS.13 an out-of-range or junk temperature is dropped", async () => {
    for (const v of ["", "hot", "-1", "9"]) {
      expect(await bodyFor({ DEEPSEEK_THINKING: "disabled", DEEPSEEK_TEMPERATURE: v }), v).not.toHaveProperty("temperature");
    }
  });

  it("DS.6 generateOnce drops reasoning_content too", async () => {
    const g = gen([
      { choices: [{ delta: { reasoning_content: "hmm" } }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
    ]);
    expect((await g.generateOnce("deepseek-v4-pro", REQ)).text).toBe("answer");
  });
});
