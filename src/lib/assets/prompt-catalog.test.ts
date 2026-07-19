// Prompt-contract tests for the 3D section (PRD-3D-GAMES-AND-ASSETS §11):
// the curated import list must stay in lockstep with the vendored bundle's
// export list, the §7 render-budget rules must be present, and §10b R1's
// preserveDrawingBuffer rule must be pinned — losing it silently would blind
// the self-healing preview's pixel probe on every 3D game.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { THREE_PROMPT_SECTION, modelsPromptSection, audioPromptSection } from "./prompt-catalog";
import { THREE_MARKER } from "./inject";
import { CHILD_SYSTEM_PROMPT, buildTurnSystemInstruction } from "../gemini";
import { ASSET_HOST_ORIGIN, type AssetManifest } from "./manifest";
import realManifest from "./manifest.json";

describe("THREE_PROMPT_SECTION — marker + import contract", () => {
  it("teaches the exact opt-in marker", () => {
    expect(THREE_PROMPT_SECTION).toContain(THREE_MARKER);
  });

  it("teaches every name the vendored bundle actually exports (lockstep with vendor-three.mjs)", () => {
    const vendorSource = readFileSync(join(__dirname, "../../../scripts/vendor-three.mjs"), "utf8");
    const listMatch = vendorSource.match(/const THREE_EXPORTS = \[([\s\S]*?)\];/);
    expect(listMatch).not.toBeNull();
    const names = [...listMatch![1]!.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(THREE_PROMPT_SECTION, `prompt must teach "${name}" (it is exported by the bundle)`).toContain(name);
    }
  });

  it("forbids imports outside the curated list", () => {
    // \s+ between words — the prompt is a wrapped template literal and a
    // re-wrap must not break this pin (same convention as gemini.prompt.test.ts).
    expect(THREE_PROMPT_SECTION).toMatch(/only\s+import\s+names\s+from\s+this\s+exact\s+list/i);
  });
});

describe("THREE_PROMPT_SECTION — §10b R1: the pixel probe must see 3D frames", () => {
  it("requires preserveDrawingBuffer: true on the renderer", () => {
    expect(THREE_PROMPT_SECTION).toMatch(/preserveDrawingBuffer:\s*true/);
  });
});

describe("THREE_PROMPT_SECTION — §7 render budget on kid hardware", () => {
  it("caps the pixel ratio at 2", () => {
    expect(THREE_PROMPT_SECTION).toMatch(/Math\.min\(\s*(window\.)?devicePixelRatio,\s*2\s*\)/);
  });
  it("forbids shadows and post-processing", () => {
    expect(THREE_PROMPT_SECTION).toMatch(/no shadows/i);
    expect(THREE_PROMPT_SECTION).toMatch(/post-processing/i);
  });
  it("limits lights to ambient + one directional", () => {
    expect(THREE_PROMPT_SECTION).toMatch(/AmbientLight/);
    expect(THREE_PROMPT_SECTION).toMatch(/DirectionalLight/);
    expect(THREE_PROMPT_SECTION).toMatch(/at most (one|two)|only .* lights|no more than/i);
  });
  it("keeps poly count low for phones", () => {
    expect(THREE_PROMPT_SECTION).toMatch(/low|handful/i);
    expect(THREE_PROMPT_SECTION).toMatch(/phones?|tablets?|chromebook/i);
  });
});

describe("CHILD_SYSTEM_PROMPT — 100dvh mobile sizing (BUG-FIX-LOG 2026-07-08, restored)", () => {
  it("mandates 100dvh and bans 100vh", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/100dvh/);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/NEVER 100vh/i);
  });
  it("keeps bottom controls clear of mobile browser UI (safe-area breathing room)", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/safe-area-inset-bottom/);
  });
});

describe("buildTurnSystemInstruction — what a game-build turn actually sends", () => {
  it("fully unlocked (the paid shape, and the default) carries the base prompt AND the 3D section", () => {
    const full = buildTurnSystemInstruction();
    expect(full).toContain(CHILD_SYSTEM_PROMPT);
    expect(full).toContain(THREE_PROMPT_SECTION);
  });

  it("carries the model catalog exactly when the manifest has models", () => {
    const full = buildTurnSystemInstruction();
    const hasModels = realManifest.assets.some((a) => a.type === "model");
    expect(full.includes("USES_MODELS")).toBe(hasModels);
  });
});

describe("buildTurnSystemInstruction — tier/keyword gates (PRD §9/§11: free + no keyword ≡ today's product)", () => {
  it("both gates closed → EXACTLY the bare child prompt, zero catalog tokens", () => {
    // multiplayer is a separate, independent gate (PRD-MULTIPLAYER.md Phase 4)
    // — held at false here so this stays a pure test of the 3D/audio gates.
    expect(buildTurnSystemInstruction({ three: false, audio: false }, undefined, false)).toBe(CHILD_SYSTEM_PROMPT);
  });

  it("3D gate alone → 3D + models sections, no audio catalog", () => {
    const full = buildTurnSystemInstruction({ three: true, audio: false });
    expect(full).toContain(THREE_PROMPT_SECTION);
    expect(full).not.toContain("USES_AUDIO");
  });

  it("audio gate alone → audio catalog, no engine/3D section (2D games get sound)", () => {
    const full = buildTurnSystemInstruction({ three: false, audio: true });
    expect(full).not.toContain(THREE_MARKER);
    expect(full).not.toContain("USES_MODELS");
    // The committed manifest may not carry audio yet; the gate contract is
    // that the audio section appears exactly when the manifest has audio.
    const hasAudio = realManifest.assets.some((a) => a.type === "sfx" || a.type === "music");
    expect(full.includes("USES_AUDIO")).toBe(hasAudio);
  });
});

const fakeModels: AssetManifest = {
  assets: [
    { name: "three", type: "engine", url: `${ASSET_HOST_ORIGIN}/three.${"a".repeat(6)}.js`, bytes: 580_000, license: "MIT", sourceUrl: "https://example.com", sha256: "a".repeat(64) },
    { name: "car", type: "model", url: `${ASSET_HOST_ORIGIN}/car.${"b".repeat(6)}.glb`, bytes: 14_000, license: "CC0", sourceUrl: "https://example.com", sha256: "b".repeat(64) },
    { name: "dino", type: "model", url: `${ASSET_HOST_ORIGIN}/dino.${"c".repeat(6)}.glb`, bytes: 83_000, license: "CC0", sourceUrl: "https://example.com", sha256: "c".repeat(64) },
  ],
};

describe("modelsPromptSection — the catalog version-locks with the manifest (PRD §11)", () => {
  const section = modelsPromptSection(fakeModels);

  it("names every manifest model and nothing else", () => {
    expect(section).toContain("car");
    expect(section).toContain("dino");
    // The names line lists exactly the manifest's models.
    expect(section).toMatch(/car,\s*dino|dino,\s*car/);
  });

  it("teaches the USES_MODELS marker with the exact syntax the injector parses", () => {
    expect(section).toContain("<!--USES_MODELS:");
  });

  it("teaches fail-soft: loadModel can return null and the game must keep running", () => {
    expect(section).toMatch(/null/);
    expect(section).toMatch(/keep\s+(working|running)|still\s+(work|run)/i);
  });

  it("teaches background loading — never await a model before the first frame (async-loop class)", () => {
    expect(section).toMatch(/\.then\(/);
    expect(section).toMatch(/never\s+(use\s+)?await|placeholder/i);
  });

  it("teaches AnimationMixer for animated models (dino walks)", () => {
    expect(section).toContain("AnimationMixer");
  });

  it("teaches picking a clip by NAME (run/walk) instead of blindly playing animations[0] (2026-07-15: the dino's clip[0] is an Attack pounce, not Run — a kid asking for a running dino got a hopping attack animation)", () => {
    expect(section).toMatch(/run.?\|.?walk|walk.?\|.?run/i); // the run/walk name-search pattern
    expect(section).toMatch(/\.find\(/); // searches by name, doesn't just index in
    expect(section).toContain("animations[0]"); // still the LAST-resort fallback, not the first choice
  });

  it("is empty when the manifest has no models (nothing to teach, zero tokens)", () => {
    expect(modelsPromptSection({ assets: [fakeModels.assets[0]!] })).toBe("");
  });

  it("teaches people clips (sit/sprint/emote-yes cheer) ONLY when a people model is taught (2026-07-19: stadium humans)", () => {
    const person = { name: "man", type: "model" as const, url: `${ASSET_HOST_ORIGIN}/man.${"d".repeat(6)}.glb`, bytes: 60_000, license: "CC0" as const, sourceUrl: "https://example.com", sha256: "d".repeat(64) };
    const withPerson = modelsPromptSection({ assets: [...fakeModels.assets, person] });
    expect(withPerson).toMatch(/emote-yes/);
    expect(withPerson).toMatch(/\bsit\b/);
    expect(withPerson).toMatch(/sprint/);
    // No people in the manifest → no people-clip tokens.
    expect(modelsPromptSection(fakeModels)).not.toMatch(/emote-yes/);
  });

  describe("per-genre hints (Phase F) — lockstep with the manifest", () => {
    it("hints name only models the manifest carries", () => {
      // fakeModels has car + dino only: racing shows car, animals shows dino…
      expect(section).toMatch(/racing[^:]*: car/);
      expect(section).toMatch(/animals[^:]*: dino/);
      // …and never a library name the manifest lacks.
      expect(section).not.toContain("firetruck");
      expect(section).not.toContain("boat");
    });

    it("a genre with no available models disappears entirely", () => {
      expect(section).not.toMatch(/water \/ sailing/);
      expect(section).not.toMatch(/space \/ flying/);
    });

    it("no hints block at all when no hinted model exists", () => {
      const engineOnly = fakeModels.assets[0]!;
      const unhinted = { name: "zzz", type: "model", url: `${ASSET_HOST_ORIGIN}/zzz.${"f".repeat(6)}.glb`, bytes: 1_000, license: "CC0", sourceUrl: "https://example.com", sha256: "f".repeat(64) } as const;
      expect(modelsPromptSection({ assets: [engineOnly, unhinted] })).not.toContain("Good fits");
    });
  });
});

const fakeAudio: AssetManifest = {
  assets: [
    { name: "jump", type: "sfx", url: `${ASSET_HOST_ORIGIN}/jump.${"d".repeat(6)}.mp3`, bytes: 7_000, license: "CC0", sourceUrl: "https://example.com", sha256: "d".repeat(64) },
    { name: "bg_loop_upbeat", type: "music", url: `${ASSET_HOST_ORIGIN}/bg_loop_upbeat.${"e".repeat(6)}.mp3`, bytes: 243_000, license: "CC0", sourceUrl: "https://example.com", sha256: "e".repeat(64) },
  ],
};

describe("audioPromptSection — the audio catalog version-locks with the manifest (PRD §11)", () => {
  const section = audioPromptSection(fakeAudio);

  it("names every sfx and music entry", () => {
    expect(section).toContain("jump");
    expect(section).toContain("bg_loop_upbeat");
  });

  it("teaches the USES_AUDIO marker with the exact syntax the injector parses", () => {
    expect(section).toContain("<!--USES_AUDIO:");
  });

  it("teaches playSound for effects and one-time playMusic (never in the loop)", () => {
    expect(section).toContain('playSound("jump")');
    expect(section).toContain('playMusic("bg_loop_upbeat")');
    expect(section).toMatch(/never inside the game loop/i);
  });

  it("forbids hand-rolled audio (the helper owns looping + autoplay rules — R2)", () => {
    expect(section).toMatch(/do not create your own audio/i);
  });

  it("teaches fail-soft: a failed sound is silent, the game keeps playing", () => {
    expect(section).toMatch(/silent/i);
    expect(section).toMatch(/never block on audio/i);
  });

  it("is empty when the manifest has no audio (zero tokens)", () => {
    expect(audioPromptSection({ assets: [fakeModels.assets[0]!] })).toBe("");
  });
});

describe("catalog scale ceilings (PRD §14, amended 2026-07-13: retrieval-lite)", () => {
  it("a build-turn PROMPT never teaches more than the cap, however big the library (selection, model-select.ts)", () => {
    // The real enforcement matrix lives in model-select.test.ts; this pins
    // the wiring: a context-aware section over the committed manifest can't
    // exceed the cap.
    const section = modelsPromptSection(realManifest as AssetManifest, { message: "make me a game", history: [] });
    const namesLine = section.match(/toy box: ([^.\n]+(?:\n[^.\n]+)*)\./);
    if (section) {
      const count = (namesLine?.[1] ?? "").split(",").length;
      expect(count).toBeLessThanOrEqual(30);
    }
  });

  it("the committed manifest stays under a sanity ceiling (revisit selection priorities at the next doubling)", () => {
    // Bumped 60 → 120 (2026-07-14): the catalog doubled 50 → 100 (city models,
    // race-track pieces, dragons). Selection priorities WERE revisited as part
    // of this bump — see model-select.ts GENRES, extended the same day to
    // route every new model through a genre trigger, not just name-literal
    // matching. Next doubling (~200) should get the same treatment.
    const models = realManifest.assets.filter((a) => a.type === "model");
    expect(models.length).toBeLessThanOrEqual(120);
  });
});
