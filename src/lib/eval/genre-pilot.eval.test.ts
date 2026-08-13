// Genre playbook pilot (2026-08-12, owner-directed): does a Lite→Lite→Flash
// pipeline get close to a Gemini Pro single-pass build, on REAL production 3D
// game prompts, across genres — and if not, what's the common gap per genre?
//
// OPT-IN ONLY (real paid calls): RUN_GENRE_PILOT=1.
//   node --env-file=.env ./node_modules/.bin/vitest run src/lib/eval/genre-pilot.eval.test.ts --coverage=false
//
// Fidelity rules carried over from live-game.eval.test.ts (2026-08-12 lesson:
// a harness that skips CHILD_BUILDER_CONTEXT / the retrieved-names block
// measures itself, not the model — do not repeat that mistake here):
//   - the BUILD stage of every arm carries buildTurnSystemInstruction() and
//     the real per-turn blocks.
//   - every stage of every arm gets IDENTICAL generation overrides
//     (thinkingBudget/maxOutputTokens from builderGenOverrides) — owner
//     instruction 2026-08-12 "keep the same budget and setting as flash".
//
// PRD stage exists because §2.1 of docs/2026-08-12_PRD_GenrePlaybookPipeline.md
// (Ariantra-Platform) found Flash self-descopes on a raw PRD but a compiled
// BUILD SPEC survives intact — so Lite writes the PRD, then Lite compiles that
// PRD into a build spec, then Flash builds from the spec. Same principle as
// Arm B/C from that PRD, split into two Lite stages instead of one.
import { writeFileSync, mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
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

const LIVE = process.env.RUN_GENRE_PILOT === "1";
const ONLY = process.env.GENRE_PILOT_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);

const PRO = "gemini-2.5-pro";
const LITE = "gemini-2.5-flash-lite";
const FLASH = "gemini-2.5-flash";

const OUT_DIR = "docs/experiments/2026-08-12-genre-pilot";
const GAMES_DIR = `${OUT_DIR}/games`;
const FINDINGS_PATH = `${OUT_DIR}/FINDINGS.md`;

const PILOT: Array<{ id: string; genre: string; prompt: string }> = JSON.parse(
  readFileSync(`${OUT_DIR}/pilot-set.json`, "utf8"),
);

const PRD_SYSTEM = `You write a short game-design PRD for a children's 3D web game builder. Given the child's request, produce a PRD with: Concept (1-2 sentences), Core Loop, Win/Lose condition, Controls, Visual style, 5-8 concrete Features (each one sentence, concrete and testable — not "make it fun"), and a Scene description (what's visible, what moves). Plain markdown. No code. Be concrete: name real numbers (lap counts, lives, speeds) rather than vague adjectives.`;

const SPEC_SYSTEM = `You convert a game PRD into a BUILD SPEC for an AI code generator that will emit a single self-contained HTML file using three.js. The generator tends to self-descope a long PRD into a smaller MVP and defer features to "next steps" — your job is to prevent that. Rewrite the PRD as an unambiguous, numbered feature checklist the generator MUST implement in the first pass, with concrete acceptance numbers for each item (e.g. "4 laps, lap counter visible top-left" not "add laps"). End with the line: "Build ALL of the above in this one pass. Do not defer any item to a future version." Plain markdown, no code.`;

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
    usage: u
      ? {
          promptTokens: u.promptTokenCount ?? 0,
          outputTokens: u.candidatesTokenCount ?? 0,
          thoughtTokens: u.thoughtsTokenCount ?? 0,
        }
      : undefined,
  };
}

function serveTurn(prompt: string) {
  const names = modelNamesBlock(retrievedModelNames({ message: prompt, history: [] }));
  return {
    message: [CHILD_BUILDER_CONTEXT, prompt, names].filter(Boolean).join("\n\n"),
    systemInstruction: buildTurnSystemInstruction({ three: true, audio: true }, false, false, false),
  };
}

function toServedHtml(raw: string): string | undefined {
  const { artifactHtml } = extractArtifact(raw);
  if (!artifactHtml) return undefined;
  return ensureMultiplayerMarker(
    ensureAssetRuntime(ensureThreeImports(stripRuntimeGlobalImports(injectAssets(artifactHtml).html))),
  );
}

describe.runIf(LIVE)("genre playbook pilot (paid — opt-in)", () => {
  it(
    "runs Pro single-pass vs Lite→Lite→Flash pipeline on real production 3D prompts, per genre",
    { timeout: 60 * 60_000 },
    async () => {
      mkdirSync(GAMES_DIR, { recursive: true });
      if (!existsSync(FINDINGS_PATH)) {
        writeFileSync(
          FINDINGS_PATH,
          `# Genre playbook pilot — findings\n\nReal production 3D-game initial prompts (see pilot-set.json), each run two ways with IDENTICAL generation overrides (thinkingBudget/maxOutputTokens from builderGenOverrides):\n\n- **PRO** — \`${PRO}\` single pass, real production turn (buildTurnSystemInstruction + CHILD_BUILDER_CONTEXT + retrieved model names).\n- **PIPELINE** — \`${LITE}\` writes a PRD → \`${LITE}\` compiles it into a build spec → \`${FLASH}\` builds from the spec with the real production turn.\n\nServed locally: \`python3 -m http.server 8765\` from \`${GAMES_DIR}\`.\n\n---\n\n`,
        );
      }

      const ai = new GoogleGenAI(googleClientOptions(process.env));
      const items = ONLY ? PILOT.filter((p) => ONLY.includes(p.genre)) : PILOT;

      for (const item of items) {
        const dir = `${GAMES_DIR}/${item.id}`;
        mkdirSync(dir, { recursive: true });
        const section: string[] = [`## ${item.genre} — \`${item.id}\`\n`, `**Prompt:** ${item.prompt.slice(0, 300)}\n`];

        try {
          // --- ARM PRO ---
          const turn = serveTurn(item.prompt);
          const pro = await generate(ai, PRO, { system: turn.systemInstruction, user: turn.message });
          const proServed = toServedHtml(pro.text);
          if (proServed) writeFileSync(`${dir}/pro.served.html`, proServed);
          section.push(
            `- **PRO** (${PRO}): ${pro.ms}ms, ${pro.usage?.outputTokens ?? 0} out (${pro.usage?.thoughtTokens ?? 0} thinking), ${proServed ? `${proServed.length} chars → \`${item.id}/pro.served.html\`` : "**NO ARTIFACT**"}`,
          );
        } catch (err) {
          section.push(`- **PRO**: ERROR — ${err instanceof Error ? err.message : String(err)}`);
        }
        appendFileSync(FINDINGS_PATH, section.join("\n") + "\n");
        section.length = 0;

        try {
          // --- ARM PIPELINE ---
          const prd = await generate(ai, LITE, { system: PRD_SYSTEM, user: item.prompt });
          writeFileSync(`${dir}/pipeline.prd.md`, prd.text);
          const spec = await generate(ai, LITE, { system: SPEC_SYSTEM, user: prd.text });
          writeFileSync(`${dir}/pipeline.spec.md`, spec.text);
          const turn = serveTurn(spec.text);
          const build = await generate(ai, FLASH, { system: turn.systemInstruction, user: turn.message });
          const pipelineServed = toServedHtml(build.text);
          if (pipelineServed) writeFileSync(`${dir}/pipeline.served.html`, pipelineServed);
          const totalMs = prd.ms + spec.ms + build.ms;
          const totalOut = (prd.usage?.outputTokens ?? 0) + (spec.usage?.outputTokens ?? 0) + (build.usage?.outputTokens ?? 0);
          appendFileSync(
            FINDINGS_PATH,
            `- **PIPELINE** (${LITE}→${LITE}→${FLASH}): ${totalMs}ms total, ${totalOut} out combined, ${pipelineServed ? `${pipelineServed.length} chars → \`${item.id}/pipeline.served.html\`` : "**NO ARTIFACT**"} (spec: \`${item.id}/pipeline.spec.md\`)\n`,
          );
        } catch (err) {
          appendFileSync(FINDINGS_PATH, `- **PIPELINE**: ERROR — ${err instanceof Error ? err.message : String(err)}\n`);
        }
        appendFileSync(FINDINGS_PATH, `\n_gap notes: ⟨fill in after opening both URLs⟩_\n\n---\n\n`);
      }

      expect(items.length).toBeGreaterThan(0);
    },
  );
});

describe("genre pilot wiring", () => {
  it("PRD and spec system prompts forbid self-descoping and vague adjectives", () => {
    expect(SPEC_SYSTEM).toMatch(/self-descope|MVP|next steps/i);
    expect(SPEC_SYSTEM).toContain("Do not defer");
  });

  it("pilot set loads and every item has a genre + prompt", () => {
    expect(PILOT.length).toBeGreaterThanOrEqual(10);
    for (const p of PILOT) {
      expect(p.genre).toBeTruthy();
      expect(p.prompt.length).toBeGreaterThan(0);
    }
  });
});
