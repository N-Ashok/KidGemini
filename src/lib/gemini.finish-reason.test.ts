// finishReason handling (KNOWN_BUGS #4): a stream that ends empty is no longer
// an undifferentiated dud slot. SAFETY is a verdict (fail closed — never walk
// the chain to bypass it); MAX_TOKENS is fixable (retry THIS model once with a
// smaller thinking budget); anything else still walks. Same real-GeminiChatModel
// harness as gemini.fallback.test.ts, which stays untouched.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const generateContentStream = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContentStream: (...a: unknown[]) => generateContentStream(...a) };
  },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "h",
    HARM_CATEGORY_HATE_SPEECH: "hs",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "se",
    HARM_CATEGORY_DANGEROUS_CONTENT: "dc",
  },
  HarmBlockThreshold: { BLOCK_LOW_AND_ABOVE: "low", BLOCK_MEDIUM_AND_ABOVE: "med" },
}));

vi.mock("./retry", () => ({
  withRetry: (fn: () => unknown) => fn(),
  withTimeout: (fn: () => unknown) => fn(),
}));

import { GeminiChatModel, summarizeSafetyRatings } from "./gemini";
import { SafetyBlockedError } from "./model-runner";

/** A normal answer stream. */
async function* answer(text: string) {
  yield { candidates: [{ content: { parts: [{ text }] } }] };
}
/** Thinks (no answer), then the provider ends with `finishReason` and no parts. */
async function* emptyWith(finishReason: string) {
  yield { candidates: [{ content: { parts: [{ text: "planning…", thought: true }] } }] };
  yield { candidates: [{ finishReason }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } };
}
/** A SAFETY finish that also reports per-category ratings (attribution). */
async function* safetyWithRatings(ratings: Array<{ category?: string; probability?: string; blocked?: boolean }>) {
  yield { candidates: [{ content: { parts: [{ text: "planning…", thought: true }] } }] };
  yield { candidates: [{ finishReason: "SAFETY", safetyRatings: ratings }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } };
}

const calledModels = () => generateContentStream.mock.calls.map((c) => (c[0] as { model: string }).model);
const thinkingBudgets = () =>
  generateContentStream.mock.calls.map((c) => (c[0] as { config: { thinkingConfig?: { thinkingBudget?: number } } }).config.thinkingConfig?.thinkingBudget);

async function collect(model: GeminiChatModel) {
  const out: { kind: string; text: string }[] = [];
  for await (const c of model.replyStream({ history: [], message: "make me a game" })) out.push(c);
  return out;
}

beforeEach(() => {
  generateContentStream.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_CHAT_MODEL = "gemini-3-flash-preview";
});

describe("finishReason — SAFETY fails closed", () => {
  it("FR.1 a SAFETY finish throws SafetyBlockedError and NEVER tries another model", async () => {
    generateContentStream.mockResolvedValueOnce(emptyWith("SAFETY"));
    const model = new GeminiChatModel();
    await expect(collect(model)).rejects.toBeInstanceOf(SafetyBlockedError);
    expect(generateContentStream).toHaveBeenCalledTimes(1); // no chain walk to bypass safety
  });

  it("FR.2 sibling block reasons (PROHIBITED_CONTENT) also fail closed", async () => {
    generateContentStream.mockResolvedValueOnce(emptyWith("PROHIBITED_CONTENT"));
    const model = new GeminiChatModel();
    await expect(collect(model)).rejects.toBeInstanceOf(SafetyBlockedError);
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it("FR.6 a SAFETY block carries the offending category+confidence for attribution (owner ask 2026-07-22)", async () => {
    generateContentStream.mockResolvedValueOnce(
      safetyWithRatings([
        { category: "HARM_CATEGORY_HATE_SPEECH", probability: "MEDIUM", blocked: true },
        { category: "HARM_CATEGORY_HARASSMENT", probability: "LOW" },
      ]),
    );
    const model = new GeminiChatModel();
    const err = await collect(model).then(() => null, (e) => e as SafetyBlockedError);
    expect(err).toBeInstanceOf(SafetyBlockedError);
    // The route logs this so a pastor's benign-content block is attributable.
    expect(err!.safetyInfo).toBe("HATE_SPEECH:MEDIUM(blocked)");
  });
});

describe("summarizeSafetyRatings — attribution string (BUG-FIX-LOG 2026-07-22)", () => {
  it("prefers the explicitly-blocked category", () => {
    expect(
      summarizeSafetyRatings([
        { category: "HARM_CATEGORY_HARASSMENT", probability: "LOW" },
        { category: "HARM_CATEGORY_HATE_SPEECH", probability: "MEDIUM", blocked: true },
      ]),
    ).toBe("HATE_SPEECH:MEDIUM(blocked)");
  });

  it("falls back to anything above NEGLIGIBLE/LOW when nothing is flagged blocked", () => {
    expect(
      summarizeSafetyRatings([
        { category: "HARM_CATEGORY_HARASSMENT", probability: "NEGLIGIBLE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", probability: "HIGH" },
      ]),
    ).toBe("HATE_SPEECH:HIGH");
  });

  it("is undefined when there are no ratings", () => {
    expect(summarizeSafetyRatings(undefined)).toBeUndefined();
    expect(summarizeSafetyRatings([])).toBeUndefined();
  });
});

describe("finishReason — MAX_TOKENS retries the same model once with a smaller thinking budget", () => {
  it("FR.3 a MAX_TOKENS finish retries THIS model (reduced budget), and its answer wins", async () => {
    generateContentStream
      .mockResolvedValueOnce(emptyWith("MAX_TOKENS")) // thinking ate the output allowance
      .mockResolvedValueOnce(answer("Here's your game!")); // retry succeeds
    const model = new GeminiChatModel();
    const out = await collect(model);

    expect(out.some((c) => c.kind === "delta" && c.text.includes("Here's your game"))).toBe(true);
    expect(generateContentStream).toHaveBeenCalledTimes(2);
    const models = calledModels();
    expect(models[0]).toBe(models[1]); // SAME model retried, not the next in the chain
    const budgets = thinkingBudgets();
    expect(budgets[1]).toBeLessThan(budgets[0]!); // budget was reduced on the retry
  });

  it("FR.4 the reduced-budget retry happens at most ONCE — a second MAX_TOKENS walks the chain", async () => {
    generateContentStream
      .mockResolvedValueOnce(emptyWith("MAX_TOKENS")) // primary, full budget
      .mockResolvedValueOnce(emptyWith("MAX_TOKENS")) // primary, reduced budget — still empty
      .mockResolvedValueOnce(answer("Rescued by the fallback!")); // next model
    const model = new GeminiChatModel();
    const out = await collect(model);

    expect(out.some((c) => c.kind === "delta" && c.text.includes("Rescued"))).toBe(true);
    expect(generateContentStream).toHaveBeenCalledTimes(3);
    const models = calledModels();
    expect(models[0]).toBe(models[1]); // one same-model retry…
    expect(models[2]).not.toBe(models[0]); // …then it moves DOWN the chain
  });
});

describe("finishReason — unrelated empties still walk (unchanged)", () => {
  it("FR.5 an empty completion with no/other finishReason falls back to the next model", async () => {
    generateContentStream
      .mockResolvedValueOnce(emptyWith("OTHER"))
      .mockResolvedValueOnce(answer("Fallback game!"));
    const model = new GeminiChatModel();
    const out = await collect(model);

    expect(out.some((c) => c.kind === "delta" && c.text.includes("Fallback game"))).toBe(true);
    const models = calledModels();
    expect(models[1]).not.toBe(models[0]); // walked to the next model (no same-model retry)
  });
});
