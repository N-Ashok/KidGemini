// LIVE single-game probe — "does this model actually build a playable game,
// how long did it take, and what did it cost?"
//
// OPT-IN ONLY: it makes a real, paid API call, so it is skipped unless
// RUN_LIVE_GAME=1. Normal `npm test` never runs it.
//
//   npm run eval:live-game                                   # google, current backend
//   LIVE_GAME_PROVIDER=deepseek npm run eval:live-game
//   LIVE_GAME_PROVIDER=deepseek LIVE_GAME_MODEL=deepseek-v4-pro npm run eval:live-game
//   LIVE_GAME_PROMPT="make a maze game" npm run eval:live-game
//
// Deliberately NARROWER than portability.eval.test.ts (whole corpus, every
// provider, gates on refusals/harm). This answers the first question you have
// when a model is newly wired or a backend is flipped: ONE real build turn, the
// REAL system prompt and builder config, the artifact written to disk in both
// raw and served shapes, and the token/latency/cost line persisted to JSON
// (vitest's reporter swallows console output on a pass).
//
// FAITHFUL TO PRODUCTION, in the two ways that decide whether a comparison
// means anything:
//   1. the turn carries buildTurnSystemInstruction() — the real child-safety +
//      3D prompt, not a stub;
//   2. Google gets builderGenOverrides() — the bounded thinking budget and
//      24576-token headroom a real game-BUILD turn gets (builder-mode.ts).
// Comparing a model configured any other way would compare something no child
// ever runs. Global CLAUDE.md rule 12: build the instrument, don't spend an
// owner UAT round finding this out.

import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTurnSystemInstruction, extractArtifact, CHILD_BUILDER_CONTEXT } from "../gemini";
import { modelNamesBlock, retrievedModelNames } from "../assets/prompt-catalog";
import { builderGenOverrides } from "../builder-mode";
import { googleClientOptions } from "../google-backend";
import { DeepSeekGenerator } from "../providers/deepseek-generation";
import { OpenAIGenerator } from "../providers/openai-generation";
import { MoonshotGenerator } from "../providers/moonshot-generation";
import { AnthropicGenerator } from "../providers/anthropic-generation";
import { referenceCostUsd, specFor } from "../model-registry";
import { injectAssets } from "../assets/inject";
import { ensureAssetRuntime } from "../assets/ensure-runtime";
import { ensureThreeImports, stripRuntimeGlobalImports } from "../assets/three-import-lint";
import { ensureMultiplayerMarker } from "../multiplayer-gate";
import type { GenerationRequest, NormalizedUsage } from "@/types/model-provider.types";

const LIVE = process.env.RUN_LIVE_GAME === "1";
const PROVIDER = process.env.LIVE_GAME_PROVIDER ?? "google";
const PROMPT =
  process.env.LIVE_GAME_PROMPT ??
  "make a game where a rocket dodges asteroids and I score points for each one I miss";

const DEFAULT_MODEL: Record<string, string | undefined> = {
  google: process.env.GEMINI_CHAT_MODEL ?? "gemini-3.5-flash",
  deepseek: "deepseek-v4-flash",
  openai: "gpt-5.6-luna",
  moonshot: "kimi-k2",
  anthropic: "claude-opus-4-8",
};
const MODEL = process.env.LIVE_GAME_MODEL ?? DEFAULT_MODEL[PROVIDER] ?? "";

/**
 * The turn exactly as the real route builds it.
 *
 * The system prompt alone is NOT the whole turn. A production build turn also
 * carries two per-turn blocks that GeminiChatModel.configFor adds
 * (gemini.ts:616-632), and leaving either out quietly changes what is being
 * measured:
 *
 *  - `CHILD_BUILDER_CONTEXT` — the leading safety/builder context block.
 *  - `modelNamesBlock(retrievedModelNames(...))` — the retrieved 3D model NAMES
 *    for this specific ask (64 names / 788 chars for the rocket prompt). The
 *    system prompt's catalog section is counts-only by design; the names ride
 *    per-turn. Without them a model cannot know `fighter_jet` exists, so
 *    "it ignored the asset catalog" would be an unfair verdict rather than a
 *    finding — the first version of this probe made exactly that mistake.
 *
 * Both ride on the MESSAGE (buildChatContents puts safetyContext first and the
 * names block last), which is provider-neutral — so every provider gets the
 * identical turn, not just the identical system prompt.
 */
function buildRequest(message: string): GenerationRequest {
  const names = modelNamesBlock(retrievedModelNames({ message, history: [] }));
  return {
    history: [],
    message: [CHILD_BUILDER_CONTEXT, message, names].filter(Boolean).join("\n\n"),
    systemInstruction: buildTurnSystemInstruction({ three: true, audio: true }, false, false, false),
    maxOutputTokens: builderGenOverrides(process.env).maxOutputTokens,
  };
}

/** Google runs natively (not through an adapter), so it needs its own runner —
 *  and it goes through googleClientOptions so the probe follows GEMINI_BACKEND
 *  (studio | vertex) exactly like production does. */
async function generateGoogle(model: string, req: GenerationRequest) {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI(googleClientOptions(process.env));
  const overrides = builderGenOverrides(process.env);
  const res = await client.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: req.message }] }],
    config: {
      systemInstruction: req.systemInstruction,
      maxOutputTokens: overrides.maxOutputTokens,
      thinkingConfig: overrides.thinkingConfig,
    },
  });
  const u = res.usageMetadata;
  const usage: NormalizedUsage | undefined = u
    ? {
        promptTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        thoughtTokens: u.thoughtsTokenCount ?? 0,
        cachedTokens: u.cachedContentTokenCount ?? 0,
      }
    : undefined;
  return { text: res.text ?? "", usage };
}

function generate(model: string, req: GenerationRequest) {
  switch (PROVIDER) {
    case "google": return generateGoogle(model, req);
    case "deepseek": return new DeepSeekGenerator().generateOnce(model, req);
    case "openai": return new OpenAIGenerator().generateOnce(model, req);
    case "moonshot": return new MoonshotGenerator().generateOnce(model, req);
    case "anthropic": return new AnthropicGenerator().generateOnce(model, req);
    default: throw new Error(`unknown LIVE_GAME_PROVIDER=${PROVIDER}`);
  }
}

describe.runIf(LIVE)("LIVE game build (paid — opt-in)", () => {
  it(`builds a real game and reports tokens + cost`, { timeout: 15 * 60_000 }, async () => {
    const spec = specFor(MODEL);
    const req = buildRequest(PROMPT);

    const started = Date.now();
    const { text, usage } = await generate(MODEL, req);
    const ms = Date.now() - started;

    const { artifactHtml, text: chat } = extractArtifact(text);

    // The RAW model output is not what a child runs: route.ts:527-551 puts every
    // generated game through this injection chain first, and that chain is what
    // supplies the `three` import map. Verifying raw HTML would fail every
    // provider — Gemini included — for a reason the product does not have.
    const served = artifactHtml
      ? ensureMultiplayerMarker(
          ensureAssetRuntime(ensureThreeImports(stripRuntimeGlobalImports(injectAssets(artifactHtml).html))),
        )
      : undefined;

    mkdirSync("logs", { recursive: true });
    // The CONFIG belongs in the filename, not just the model. Naming by model
    // alone meant three v4-flash runs at different reasoning efforts each
    // clobbered the previous one, and the only config that produced a working
    // game was gone before it could be opened (2026-08-12).
    const cfg = [
      process.env.DEEPSEEK_THINKING && `think-${process.env.DEEPSEEK_THINKING}`,
      process.env.DEEPSEEK_REASONING_EFFORT && `effort-${process.env.DEEPSEEK_REASONING_EFFORT}`,
      process.env.DEEPSEEK_TEMPERATURE && `t${process.env.DEEPSEEK_TEMPERATURE}`,
      PROVIDER === "google" && process.env.GEMINI_BACKEND && `via-${process.env.GEMINI_BACKEND}`,
    ].filter(Boolean).join("-");
    const stem = `logs/live-game-${PROVIDER}-${MODEL}${cfg ? `-${cfg}` : ""}`;
    if (artifactHtml) writeFileSync(`${stem}.html`, artifactHtml);
    if (served) writeFileSync(`${stem}.served.html`, served);

    const cost = usage && spec
      ? ((usage.promptTokens - usage.cachedTokens) / 1e6) * spec.inputPerMTok +
        (usage.cachedTokens / 1e6) * (spec.cachedInputPerMTok ?? spec.inputPerMTok * 0.25) +
        (usage.outputTokens / 1e6) * spec.outputPerMTok
      : undefined;

    const report = {
      provider: PROVIDER,
      model: MODEL,
      backend: PROVIDER === "google" ? (process.env.GEMINI_BACKEND ?? "studio") : undefined,
      tier: spec?.tier,
      catalogued: !!spec,
      prompt: PROMPT,
      turnChars: req.message.length,
      latencyMs: ms,
      systemInstructionChars: req.systemInstruction.length,
      maxOutputTokens: req.maxOutputTokens,
      chatText: chat,
      rawHtmlChars: artifactHtml?.length ?? 0,
      servedHtmlChars: served?.length ?? 0,
      usage,
      costUsd: cost,
      referenceCostUsd: spec ? referenceCostUsd(spec) : undefined,
      files: { raw: `${stem}.html`, served: `${stem}.served.html` },
    };
    writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    // The gate: a build turn must produce a real, self-contained HTML document.
    expect(artifactHtml, "no game HTML in the reply").toBeTruthy();
    expect(artifactHtml!.toLowerCase()).toMatch(/<!doctype html|<html[\s>]/);
    expect(artifactHtml!).toMatch(/<\/html>/i); // not truncated mid-document
    expect(usage?.outputTokens ?? 0).toBeGreaterThan(0);
  });
});

// Always-on guard so the file isn't dead weight when the probe is off.
describe("live-game probe wiring", () => {
  it("builds a real GenerationRequest carrying the child-safety prompt and builder headroom", () => {
    const req = buildRequest("make a 3d rocket game");
    expect(req.systemInstruction.length).toBeGreaterThan(100); // the real prompt, not a stub
    expect(req.maxOutputTokens).toBe(24576); // builder headroom, not the 8192 chat default
    expect(req.message).toContain("make a 3d rocket game"); // the child's words survive
  });

  it("carries the per-turn blocks a production build turn sends, not just the system prompt", () => {
    // The regression this pins: the first version of this probe sent ONLY the
    // system prompt, so no model could know which 3D models exist, and the
    // resulting "it ignored the asset catalog" verdict was measuring the
    // harness rather than the model.
    const req = buildRequest("make a 3d rocket game that dodges asteroids");
    expect(req.message.startsWith(CHILD_BUILDER_CONTEXT)).toBe(true);
    expect(req.message).toContain("fighter_jet"); // the retrieved names block rides last
    expect(req.message.indexOf("fighter_jet")).toBeGreaterThan(req.message.indexOf("dodges asteroids"));
  });
});
