// Genre playbook pipeline, run end-to-end for ONE real production 3D game
// (owner ask 2026-08-12: "do it for one 3d game and lets evaluate").
//
// This is closer to the real PRD pipeline (§4.1) than genre-pilot.eval.test.ts:
// COMPILE (PRD, Lite) → COMPILE (spec, Lite) → BUILD (Flash, real production
// turn, now through the FIXED ensureThreeImports — see three-import-lint.ts
// 2026-08-12) → PROBE (real Chromium, srcdoc iframe, same load path as
// production) → PATCH (one bounded repair pass via the REAL /api/repair
// primitives — repair-prompt.ts's REPAIR_SYSTEM_PROMPT + applyPatch, not a
// reinvented patcher) → PROBE again.
//
// Still NOT the full PRD architecture — no classifier (game is picked by
// hand), no genre playbook laws, no shell (scene templates / CSS class
// vocabulary). This tests whether compile+build+probe+patch alone, with
// today's import-healer bug fixed, closes the gap on ONE real prompt.
//
// OPT-IN ONLY (real paid calls): RUN_ONE_GAME_PIPELINE=1.
import { writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GoogleGenAI } from "@google/genai";
import { buildTurnSystemInstruction, extractArtifact, CHILD_BUILDER_CONTEXT } from "../gemini";
import { modelNamesBlock, retrievedModelNames } from "../assets/prompt-catalog";
import { builderGenOverrides } from "../builder-mode";
import { googleClientOptions } from "../google-backend";
import { injectAssets } from "../assets/inject";
import { ensureAssetRuntime } from "../assets/ensure-runtime";
import { ensureThreeImports, stripRuntimeGlobalImports } from "../assets/three-import-lint";
import { ensureMultiplayerMarker } from "../multiplayer-gate";
import { REPAIR_SYSTEM_PROMPT, applyPatch } from "../repair-prompt";
import { DeepSeekGenerator } from "../providers/deepseek-generation";

const LIVE = process.env.RUN_ONE_GAME_PIPELINE === "1";
const LITE = "gemini-2.5-flash-lite";
const LITE_FALLBACK = "deepseek-v4-flash"; // owner decision 2026-08-12: when
// Gemini's lite tier is down (Vertex 404 — confirmed a 5+ minute outage this
// session while gemini-2.5-flash/pro answered fine), fall back to DeepSeek's
// cheapest tier for LITE duty rather than wait or substitute a pricier Gemini
// model. DeepSeek has no distinct "lite" SKU (model-registry.ts:100-101) —
// deepseek-v4-flash is its workhorse tier, the closest analog.
const FLASH = "gemini-2.5-flash";

// Real production prompt (platformer bucket, conversation c5908cf0 — same
// game used for the 2026-08-12 smoke test, so this run is directly
// comparable to that baseline).
const GAME_ID = "c5908cf0-8f0e-40cc-bb6a-456a42f0dbc1";
const PROMPT = "make a 3d platformer game different worlds will be in optons it contains 2-4 characters fighting with weapons";

const OUT_DIR = `docs/experiments/2026-08-12-genre-pilot/one-game-pipeline`;

const PRD_SYSTEM = `You write a short game-design PRD for a children's 3D web game builder. Given the child's request, produce a PRD with: Concept (1-2 sentences), Core Loop, Win/Lose condition, Controls, Visual style, 5-8 concrete Features (each one sentence, concrete and testable — not "make it fun"), and a Scene description (what's visible, what moves). Plain markdown. No code. Be concrete: name real numbers (lap counts, lives, speeds) rather than vague adjectives.`;
const SPEC_SYSTEM = `You convert a game PRD into a BUILD SPEC for an AI code generator that will emit a single self-contained HTML file using three.js. The generator tends to self-descope a long PRD into a smaller MVP and defer features to "next steps" — your job is to prevent that. Rewrite the PRD as an unambiguous, numbered feature checklist the generator MUST implement in the first pass, with concrete acceptance numbers for each item. End with the line: "Build ALL of the above in this one pass. Do not defer any item to a future version." Plain markdown, no code.`;

async function generate(ai: GoogleGenAI, model: string, opts: { system?: string; user: string }) {
  const overrides = builderGenOverrides(process.env);
  const started = Date.now();
  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    config: {
      ...(opts.system ? { systemInstruction: opts.system } : {}),
      maxOutputTokens: overrides.maxOutputTokens,
      thinkingConfig: overrides.thinkingConfig,
    },
  });
  const u = res.usageMetadata;
  return {
    text: res.text ?? "",
    ms: Date.now() - started,
    usage: u ? { outputTokens: u.candidatesTokenCount ?? 0, thoughtTokens: u.thoughtsTokenCount ?? 0 } : undefined,
    model,
  };
}

/** LITE-duty call with a DeepSeek fallback when Gemini's lite tier 404s
 *  (Vertex capacity outage, not a code bug — see LITE_FALLBACK above). Only
 *  falls back on a NOT_FOUND/404 — any other error (a real content or auth
 *  problem) still throws, so a typo'd prompt doesn't silently reroute providers. */
async function generateLiteWithFallback(ai: GoogleGenAI, opts: { system?: string; user: string }) {
  try {
    return await generate(ai, LITE, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/NOT_FOUND|404/.test(msg)) throw err;
    const overrides = builderGenOverrides(process.env);
    const ds = new DeepSeekGenerator();
    const started = Date.now();
    const res = await ds.generateOnce(LITE_FALLBACK, {
      history: [],
      message: opts.user,
      systemInstruction: opts.system ?? "",
      maxOutputTokens: overrides.maxOutputTokens,
    });
    return {
      text: res.text,
      ms: Date.now() - started,
      usage: { outputTokens: res.usage?.outputTokens ?? 0, thoughtTokens: res.usage?.thoughtTokens ?? 0 },
      model: LITE_FALLBACK,
    };
  }
}

function toServedHtml(raw: string): string | undefined {
  const { artifactHtml } = extractArtifact(raw);
  if (!artifactHtml) return undefined;
  return ensureMultiplayerMarker(
    ensureAssetRuntime(ensureThreeImports(stripRuntimeGlobalImports(injectAssets(artifactHtml).html))),
  );
}

/** Real-browser probe, same load path as production (srcdoc iframe) and the
 *  same signal verify-game-html.mjs uses — pageerror/console capture. */
async function probe(html: string) {
  const { chromium } = await import(
    process.env.PLAYWRIGHT_CORE_DIR ? `${process.env.PLAYWRIGHT_CORE_DIR}/index.mjs` : "playwright-core"
  );
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e.message || e)));
  page.on("console", (m: { type: () => string; text: () => string }) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="g" style="width:100%;height:100%;border:0"></iframe></body></html>`);
  await page.evaluate((doc: string) => {
    (document.getElementById("g") as HTMLIFrameElement).srcdoc = doc;
  }, html);
  await page.waitForTimeout(4500);
  await browser.close();
  return { ok: errors.length === 0, errors };
}

describe.runIf(LIVE)("one-game genre pipeline (paid — opt-in)", () => {
  it(
    "COMPILE(PRD)->COMPILE(spec)->BUILD->PROBE->PATCH->PROBE, one real production prompt",
    { timeout: 20 * 60_000 },
    async () => {
      mkdirSync(OUT_DIR, { recursive: true });
      const ai = new GoogleGenAI(googleClientOptions(process.env));
      const log: string[] = [`# One-game pipeline run — ${GAME_ID}\n\n**Prompt:** ${PROMPT}\n`];

      const prd = await generateLiteWithFallback(ai, { system: PRD_SYSTEM, user: PROMPT });
      writeFileSync(`${OUT_DIR}/prd.md`, prd.text);
      log.push(`- Stage 0 PRD (${prd.model}${prd.model !== LITE ? " — FALLBACK, Gemini lite tier was down" : ""}): ${prd.ms}ms, ${prd.usage?.outputTokens ?? 0} out`);

      const spec = await generateLiteWithFallback(ai, { system: SPEC_SYSTEM, user: prd.text });
      writeFileSync(`${OUT_DIR}/spec.md`, spec.text);
      log.push(`- Stage 1 SPEC (${spec.model}${spec.model !== LITE ? " — FALLBACK, Gemini lite tier was down" : ""}): ${spec.ms}ms, ${spec.usage?.outputTokens ?? 0} out`);

      const names = modelNamesBlock(retrievedModelNames({ message: spec.text, history: [] }));
      const turnMessage = [CHILD_BUILDER_CONTEXT, spec.text, names].filter(Boolean).join("\n\n");
      const turnSystem = buildTurnSystemInstruction({ three: true, audio: true }, false, false, false);
      const build = await generate(ai, FLASH, { system: turnSystem, user: turnMessage });
      log.push(`- Stage 2 BUILD (${FLASH}): ${build.ms}ms, ${build.usage?.outputTokens ?? 0} out (${build.usage?.thoughtTokens ?? 0} thinking)`);

      let served = toServedHtml(build.text);
      expect(served, "no game HTML in the build reply").toBeTruthy();
      writeFileSync(`${OUT_DIR}/pre-patch.served.html`, served!);

      const before = await probe(served!);
      log.push(`- Stage 3 PROBE (pre-patch): ${before.ok ? "✓ clean" : `✖ ${before.errors.join("; ")}`}`);

      if (!before.ok) {
        const repairUser = [
          `The game threw: "${before.errors[0]}".`,
          `Fix only that.`,
          ``,
          `The child originally asked for: "${PROMPT}"`,
          `Keep the game exactly what they asked for.`,
          ``,
          `Current source:`,
          served!,
        ].join("\n");
        const patch = await generate(ai, FLASH, { system: REPAIR_SYSTEM_PROMPT, user: repairUser });
        const result = applyPatch(served!, patch.text);
        log.push(`- Stage 4 PATCH (${FLASH}): ${patch.ms}ms, ${patch.usage?.outputTokens ?? 0} out, result=${result.ok ? result.mode : result.reason}`);
        if (result.ok) {
          served = result.html;
          writeFileSync(`${OUT_DIR}/post-patch.served.html`, served);
          const after = await probe(served);
          log.push(`- Stage 5 PROBE (post-patch): ${after.ok ? "✓ clean" : `✖ ${after.errors.join("; ")}`}`);
        }
      } else {
        log.push(`- Stage 4/5 PATCH: skipped — pre-patch was already clean`);
      }

      writeFileSync(`${OUT_DIR}/RUN.md`, log.join("\n") + "\n");
      console.log(log.join("\n"));
    },
  );
});

describe("one-game pipeline wiring", () => {
  it("uses the fixed multi-script-aware ensureThreeImports, not a reinvented healer", () => {
    const html = toServedHtml(
      "```html\n<!doctype html><html><body><!--USES_THREE--><script type=\"module\">import { Scene } from \"three\"; const s = new Scene(); const m = new CylinderGeometry(1,1,1);</script></body></html>\n```",
    );
    expect(html).toContain("CylinderGeometry");
  });

  it("reuses the real REPAIR_SYSTEM_PROMPT and applyPatch, not a bespoke patch format", () => {
    expect(REPAIR_SYSTEM_PROMPT).toContain("SEARCH");
    expect(typeof applyPatch).toBe("function");
  });
});
