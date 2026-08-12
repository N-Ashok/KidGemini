#!/usr/bin/env node
// Proves a model backend actually answers, WITHOUT going through the app.
//
// Why this exists (global CLAUDE.md rule 12): "the unit suite is green" is not
// evidence that a transport switch works. The unit tests pin the option SHAPE;
// only a real call proves the key, the backend, the model id and the region all
// line up. Run this after flipping GEMINI_BACKEND, and after adding a provider
// key — before anyone opens the app.
//
// Usage (--env-file is Node's own loader; no dotenv dependency, and this script
// never parses or prints a secrets file itself):
//   node --env-file=.env scripts/check-model-backend.mjs
//   GEMINI_BACKEND=vertex node --env-file=.env scripts/check-model-backend.mjs
//   node --env-file=.env scripts/check-model-backend.mjs --model gemini-3.6-flash
//   node --env-file=.env scripts/check-model-backend.mjs --provider deepseek
//
// Keys are only ever reported as "set (N chars, …abcd)" — never in full.

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const provider = flag("provider") ?? "google";
const mask = (k) => (k ? `set (${k.length} chars, …${k.slice(-4)})` : "MISSING");

async function checkGoogle() {
  const backend = (process.env.GEMINI_BACKEND ?? "studio").trim().toLowerCase();
  if (backend !== "studio" && backend !== "vertex") {
    throw new Error(`GEMINI_BACKEND="${process.env.GEMINI_BACKEND}" is not a backend (studio | vertex)`);
  }
  const model = flag("model") ?? process.env.GEMINI_CHAT_MODEL ?? "gemini-3-flash-preview";
  const key = backend === "vertex" ? process.env.VERTEX_API_KEY : process.env.GEMINI_API_KEY;
  const keyName = backend === "vertex" ? "VERTEX_API_KEY" : "GEMINI_API_KEY";

  console.log(`backend : google / ${backend}`);
  console.log(`model   : ${model}`);
  console.log(`${keyName.padEnd(8)}: ${mask(key)}`);
  if (!key) throw new Error(`${keyName} is not set, and GEMINI_BACKEND=${backend}`);

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI(backend === "vertex" ? { vertexai: true, apiKey: key } : { apiKey: key });

  const started = Date.now();
  const res = await ai.models.generateContent({
    model,
    contents: "Reply with exactly: OK",
    config: { maxOutputTokens: 16, thinkingConfig: { thinkingBudget: 0 } },
  });
  return { text: res.text?.trim(), ms: Date.now() - started, usage: res.usageMetadata };
}

/** OpenAI-compatible providers (openai, moonshot, deepseek) share one path. */
async function checkOpenAiCompatible(id) {
  const CONF = {
    openai: { keyName: "OPENAI_API_KEY", baseURL: undefined, model: "gpt-5.4-nano" },
    moonshot: { keyName: "MOONSHOT_API_KEY", baseURL: process.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1", model: "moonshot-v1-8k" },
    deepseek: { keyName: "DEEPSEEK_API_KEY", baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1", model: "deepseek-chat" },
  }[id];
  if (!CONF) throw new Error(`unknown --provider ${id} (google | openai | moonshot | deepseek)`);

  const model = flag("model") ?? CONF.model;
  const key = process.env[CONF.keyName];
  console.log(`backend : ${id}`);
  console.log(`model   : ${model}`);
  console.log(`${CONF.keyName.padEnd(8)}: ${mask(key)}`);
  if (!key) throw new Error(`${CONF.keyName} is not set`);

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: key, ...(CONF.baseURL ? { baseURL: CONF.baseURL } : {}) });

  const started = Date.now();
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_completion_tokens: 16,
  });
  return { text: res.choices?.[0]?.message?.content?.trim(), ms: Date.now() - started, usage: res.usage };
}

try {
  const out = provider === "google" ? await checkGoogle() : await checkOpenAiCompatible(provider);
  console.log(`reply   : ${JSON.stringify(out.text)}`);
  console.log(`latency : ${out.ms}ms`);
  if (out.usage) console.log(`usage   : ${JSON.stringify(out.usage)}`);
  console.log("\n✅ backend answered — this transport is live.");
} catch (err) {
  console.error(`\n❌ ${err?.message ?? err}`);
  if (err?.status) console.error(`   HTTP ${err.status}${err.code ? ` (${err.code})` : ""}`);
  console.error("\nNothing was changed. Fix the config above and re-run.");
  process.exit(1);
}
