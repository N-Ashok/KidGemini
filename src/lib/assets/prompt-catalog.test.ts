// Prompt-contract tests for the 3D section (PRD-3D-GAMES-AND-ASSETS §11):
// the curated import list must stay in lockstep with the vendored bundle's
// export list, the §7 render-budget rules must be present, and §10b R1's
// preserveDrawingBuffer rule must be pinned — losing it silently would blind
// the self-healing preview's pixel probe on every 3D game.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { THREE_PROMPT_SECTION, modelsPromptSection, audioPromptSection, retrievedModelNames, modelNamesBlock } from "./prompt-catalog";
import { THREE_MARKER } from "./inject";
import { GENRE_IDS, modelsInGenre } from "./asset-taxonomy";
import type { ChatMessage } from "@/types/chat.types";
import { CHILD_SYSTEM_PROMPT, buildTurnSystemInstruction } from "../gemini";
import { ASSET_HOST_ORIGIN, type AssetManifest } from "./manifest";
import realManifest from "./manifest.json";
import published from "./three-exports.published.json";

describe("THREE_PROMPT_SECTION — marker + import contract", () => {
  it("teaches the exact opt-in marker", () => {
    expect(THREE_PROMPT_SECTION).toContain(THREE_MARKER);
  });

  // Was: "teaches every name in scripts/vendor-three.mjs". Retargeted at the
  // PUBLISHED list on 2026-08-16. The vendoring script is the RECIPE for the
  // next bundle; every game loads a content-hashed file already on
  // assets.ariantra.com, and editing the recipe does not change it. Under the
  // old coupling, adding an export to the recipe FORCED the prompt to teach it
  // in the same commit — advertising a name the served bundle does not have,
  // which is exactly what killed a child's game on 2026-08-15
  // (`CatmullRomCurve3`). The recipe now leads, the upload follows, and the
  // teaching comes last. See curated-imports.test.ts for the other direction.
  it("teaches every name the SERVED bundle exports (lockstep with three-exports.published.json)", () => {
    const names = published.exports.filter(
      // Internal to runtime-helpers.ts and deliberately never taught to the
      // model — it calls loadModel()/placeModel(), never the loaders.
      (n) => !["GLTFLoader", "MeshoptDecoder", "SkeletonUtils"].includes(n),
    );
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(THREE_PROMPT_SECTION, `prompt must teach "${name}" (the served bundle exports it)`).toContain(name);
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
  it("allows shadows with a modest map size, still forbids post-processing", () => {
    expect(THREE_PROMPT_SECTION).toMatch(/shadowMap\.enabled/i);
    expect(THREE_PROMPT_SECTION).toMatch(/castShadow/);
    expect(THREE_PROMPT_SECTION).toMatch(/shadow\.mapSize/);
    expect(THREE_PROMPT_SECTION).toMatch(/post-processing/i);
  });
  it("requires ambient/hemisphere fill plus one directional sun light", () => {
    expect(THREE_PROMPT_SECTION).toMatch(/AmbientLight|HemisphereLight/);
    expect(THREE_PROMPT_SECTION).toMatch(/DirectionalLight/);
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
    expect(buildTurnSystemInstruction({ three: false, audio: false }, false)).toBe(CHILD_SYSTEM_PROMPT);
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

  // CONTRACT CHANGED 2026-08-09 (the category-map hybrid,
  // docs/2026-08-09_PRD_AnimalsSnowSkiAssets.md). The section carries the
  // category map — headings and COUNTS — and no longer the names; the names
  // ride per-turn at the end of the request contents. These pin the map.
  it("maps every category that has models, with its count", () => {
    expect(section).toMatch(/racing[^:]*: 1/);
    expect(section).toMatch(/animals[^:]*: 1/);
  });

  it("does NOT spend system-prompt tokens on model names (that is the hybrid's whole point)", () => {
    const map = section.split("\nThe exact model NAMES")[0]!;
    expect(map).not.toMatch(/\bcar\b/);
    expect(map).not.toMatch(/\bdino\b/);
  });

  it("tells the model where the names actually arrive, or it would think the toy box is empty", () => {
    expect(section).toMatch(/Toy box/);
    // \s+ between words — the prompt is a wrapped template literal and a
    // re-wrap must not break this pin (same convention as the import-list pin).
    expect(section).toMatch(/end\s+of\s+this\s+conversation/i);
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

  // BUG-FIX-LOG 2026-08-12 (a generated soccer game's placeholder ball read
  // roughly beach-ball-sized next to its human-sized placeholder character):
  // rule 4 already forbids guessing a CATALOG model's size once modelSize()
  // can answer, but the PLACEHOLDER shape drawn before any model loads (rule
  // 3) had no size guidance at all — the model just picked an arbitrary
  // radius. A human-scale reference anchors every placeholder's size to the
  // same real-world unit a kid would expect.
  it("gives placeholder shapes a human-scale reference so a ball/prop doesn't come out arbitrarily huge or tiny", () => {
    expect(section).toMatch(/human/i);
    expect(section).toMatch(/1\.[5-8]\s*(units?|m\b|metres?|meters?)/i);
  });

  it("teaches AnimationMixer for animated models (dino walks)", () => {
    expect(section).toContain("AnimationMixer");
  });

  it("teaches picking a clip by NAME (run/walk) instead of blindly playing animations[0] (2026-07-15: the dino's clip[0] is an Attack pounce, not Run — a kid asking for a running dino got a hopping attack animation)", () => {
    expect(section).toMatch(/run.?\|.?walk|walk.?\|.?run/i); // the run/walk name-search pattern
    expect(section).toMatch(/\.find\(/); // searches by name, doesn't just index in
    expect(section).toContain("animations[0]"); // still the LAST-resort fallback, not the first choice
  });

  it("warns that name lookups on rigid models silently find NOTHING (2026-08-06: helicopter rotor — the GLB is one mesh named 'Cube', so traverse(/rotor|blade|prop/) matched nothing, the spin loop ran over an empty array, and Ari claimed success for turns in a row)", () => {
    expect(section).toMatch(/no\s+named\s+parts/i);
    expect(section).toMatch(/finds?\s+nothing|matches?\s+nothing/i);
    expect(section).toMatch(/silent/i); // the failure mode: a no-op, not an error
    expect(section).toMatch(/you\s+add/i); // the only spinnable parts are ones YOU add
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

  describe("category grouping — lockstep with the manifest", () => {
    it("counts models under their category heading, each counted exactly once", () => {
      // fakeModels has car + dino only: racing counts 1, animals counts 1 —
      // `car` is in BOTH racing and city in the taxonomy, and the map must not
      // double-count it or the counts stop meaning "models that exist".
      expect(section).toMatch(/racing[^:]*: 1/);
      expect(section).toMatch(/animals[^:]*: 1/);
      expect(section).not.toMatch(/city[^:]*: 1/);
      // …and never a library name the manifest lacks.
      expect(section).not.toContain("firetruck");
      expect(section).not.toContain("boat");
    });

    it("a category with no available models disappears entirely", () => {
      expect(section).not.toMatch(/water \/ sailing/);
      expect(section).not.toMatch(/space \/ flying/);
    });
  });
});

// The whole point of the 2026-07-24 rework. Selection used to pick models from
// the CHILD's words, but the catalog is consumed by the LLM's DESIGN decisions,
// which happen after selection. "make me a fun game" triggered no genre, so the
// model saw 6 of 106 models, then hand-rolled cubes for a pizza restaurant while
// 19 food models sat unused on the asset host. inject.ts resolves against the
// FULL manifest, so those names always worked — we were simply not telling it.
describe("the catalog teaches the WHOLE library (so the LLM can design against it)", () => {
  const real = realManifest as AssetManifest;
  // Path TILES are withheld from the model entirely (owner decision
  // 2026-08-15: "keep the kit out of the llm's reach, don't ever use it"), so
  // the offered library is the manifest MINUS pathRole:"tile". They remain in
  // the manifest and in the runtime helpers for the ~200 stored games that
  // already call them.
  const realModels = real.assets
    .filter((a) => a.type === "model" && a.pathRole !== "tile")
    .map((a) => a.name);
  const tileModels = real.assets
    .filter((a) => a.type === "model" && a.pathRole === "tile")
    .map((a) => a.name);
  const section = modelsPromptSection(real);

  // REPLACED 2026-08-09 by the hybrid: the guarantee is no longer "every name
  // is in the system prompt" (that is what grew without bound) but "every name
  // is REACHABLE — the map always shows its category, and the retrieval always
  // reaches it for a child who asks for it". Both halves are pinned here,
  // because a library the model cannot name is exactly the 2026-07-24 bug.
  it("maps every model into a counted category — the counts add up to the manifest", () => {
    const map = section.split("\nThe exact model NAMES")[0]!;
    const counted = [...map.matchAll(/: (\d+)$/gm)].reduce((n, m) => n + Number(m[1]), 0);
    expect(counted).toBe(realModels.length);
  });

  it("retrieval can reach EVERY model in the library — no name is unreachable", () => {
    // A child who says the model's own name must always be taught that name.
    const unreachable = realModels.filter(
      (n) => !retrievedModelNames({ message: `make a game with a ${n}`, history: [], manifest: real }).includes(n),
    );
    expect(unreachable).toEqual([]);
  });

  it("and CANNOT reach a path tile, however the child asks", () => {
    // The whole point of the withholding: even naming the piece must not
    // surface it, or the model will try to build a track out of squares again.
    expect(tileModels.length).toBeGreaterThan(0);
    for (const tile of tileModels) {
      const names = retrievedModelNames({ message: `make a track with ${tile}`, history: [], manifest: real });
      expect(names).not.toContain(tile);
    }
  });

  // Regression, 2026-08-08 (BUG-FIX-LOG fragmented race tracks): the section
  // used to say "models load at their own natural size — set m.scale and
  // m.position so they fit your scene", which is an instruction to guess with
  // nothing to guess from. The model laid 1 m road tiles 10 m apart, and no
  // amount of re-prompting could fix it because the sizes existed nowhere in
  // the prompt. These pin the teaching that replaced it.
  it("teaches modelSize() instead of telling the model to guess a size", () => {
    expect(section).toMatch(/modelSize\(name\)/);
    expect(section).toMatch(/NEVER guess a size or spacing/);
    // The exact sentence that caused the bug must not come back.
    expect(section).not.toMatch(/load at their own natural size/);
  });

  it("teaches roads as GEOMETRY, never as tiles (owner decision 2026-08-15)", () => {
    // "keep the kit out of the llm's reach, don't ever use it." A square-grid
    // kit cannot express a smooth curve or a loop — every join is a right
    // angle at a fixed module, so a non-axis-aligned track seams by
    // construction, which four rounds of fixes could not change.
    expect(section).toMatch(/ROADS AND TRACKS ARE GEOMETRY YOU BUILD/);
    expect(section).toMatch(/there is no\s+road piece in the library/);
    expect(section).not.toMatch(/fitTile|modelJoins|race_track_|road_straight/);
  });

  it("does not depend on the child's message — this is what makes the prefix cacheable", () => {
    // COST_TOKEN_BUDGET.md waste-ledger #4: a system prompt that varies per
    // message breaks Gemini implicit caching on the ~10-15k of game code behind
    // it. Byte-identical output is the property that fixes it.
    expect(modelsPromptSection(real)).toBe(section);
  });

  it("stays inside its token ceiling (§9 scale ceiling — revisit past ~1900 tokens)", () => {
    // ~4 chars/token. The ceiling is what makes "teach everything" affordable;
    // if a bulk import breaks this, the category-map hybrid is the fallback.
    // Raised 1500 → 1750 (2026-07-26): the sports batch landed at 1501 — the
    // ~250 of that from the SPORTS_PLAYBOOK is deliberate teaching content
    // (rules + team AI, owner ask), not catalog creep.
    // Raised 1750 → 1900 (2026-07-30, docs/2026-07-30_PRD_IndianGamesAssets.md
    // §3 scale-ceilings note): the library was already at ~1736 tokens before
    // this batch (208 models); the indian_games batch (+22 names, +1 genre
    // heading) measured at ~1831 — a genuinely bigger addition than prior
    // batches, as the PRD predicted, not an accidental bulk import. This is
    // the documented revisit the PRD demanded (measured by this test during
    // implementation, not assumed). Model NAMES still dominate the section;
    // an accidental bulk import still trips this.
    // Raised 2820 -> 2900 (2026-08-16): the no-curve-class rule. A child's
    // "Village Turbo Racer" shipped DEAD because the build imported
    // CatmullRomCurve3, which this platform's three bundle does not export —
    // a missing export is a parse error, so the module never ran and the
    // Start button did nothing ("startGame is not defined"). The roads
    // teaching added the evening before invited exactly that by talking about
    // laying a route out; it now says, by name, that there is no curve class
    // and to walk a plain array instead. ~30 tokens to close a whole-game
    // failure. Measured 2889.
    // Raised 2700 -> 2820 (2026-08-15, same evening): SCENERY PLACEMENT. A
    // 65-second screen recording of a child racing her own game showed an
    // empty world for the whole run, while Ari's replies said it had added
    // trees, a village, a lake and ducks across four separate turns. Measured
    // in the stored game: the props were real, but the houses and trees sat
    // at x = +/-65..90 beside an 8-wide road, and scene.fog ended at 150 — so
    // the child drove past none of them. Chickens and dogs existed only in
    // the first 290 units of an 850-unit track. This is the rule that turns
    // "I added it!" into something she can actually see. Measured 2808.
    // Raised 2600 -> 2700 (2026-08-15, same day): the DRIVING SETUP block —
    // the owner's race game had a correct-looking chase camera that still felt
    // wrong, because `back = 12` was a bare number in a world built ~10x the
    // car's scale, leaving the car a speck in an empty field. Measured in a
    // real browser (camera trailed correctly at ~12 units; the car is 2.56
    // units long while the track spans 145). The block ties heading, model
    // rotation, camera distance-in-car-lengths, world scale and the Up/Down
    // mapping together, because getting any one of them out of step is what
    // produces "the cars are going in the reverse direction". Measured 2696.
    // Raised 2525 -> 2600 (2026-08-15): four faults were taught this day, each
    // traced to a specific broken game — per-model FACING (a child's kart
    // driving at the camera), modelHeading for anything that STEERS (both cars
    // in a race game driving in reverse), intent ("realistic" means 3D), and
    // chase-camera placement. The section simultaneously LOST the tile-kit
    // teaching when the road kit was withheld, so this is +28 net over the old
    // ceiling for four distinct fault classes. Fault-driven teaching, not
    // catalog creep — measured 2553.
    // Raised 2300 → 2350 (2026-08-06, BUG-FIX-LOG rotor no-op): rule 7 now
    // states that rigid models have NO named parts and a name lookup is a
    // silent no-op — verified against the live helicopter GLB (one mesh,
    // "Cube") and a real stored game whose traverse(/rotor|blade|prop/)
    // matched nothing while Ari claimed success. ~40 tokens of fault-driven
    // teaching, not catalog creep. Measured 2334.
    // Raised 1900 → 2100 (2026-08-05, TECH_DEBT #87 follow-up — model-rig
    // audit, verified against the actual staged GLBs): the "people"/"soldier"
    // clauses gained held-prop guidance (parent to the arm/lower-arm bone,
    // not the root — these packs have no hand bone; `soldier.add(gun)` at
    // the ROOT never tracked arm movement at all), and a new item 6 teaches a
    // procedural-motion fallback (bone-driven gait, or a fake spun primitive
    // on a rigid mesh) for any model missing the locomotion clip or rig a
    // game needs — a real, common gap (confirmed on `dog`/`bird`/vehicles),
    // not catalog creep.
    // Raised 2100 → 2300 (2026-08-06, docs/2026-08-06_PRD_MotorcycleAssets.md):
    // the motorcycle batch adds 13 names (owner ask: "at least 10 types of
    // motorcycle") plus the community-art credit clause — the clause is
    // LICENSE-required teaching (the platform's chip must not be removed or
    // re-implemented by the model), not catalog creep. Measured ~2179 during
    // implementation. The category-map hybrid fallback the section doc
    // promises is the next step if a batch pushes past this line.
    // Raised 2350 → 2400 (2026-08-08, BUG-FIX-LOG fragmented race tracks):
    // rule 4 was REWRITTEN, not extended. Its old first sentence ("models load
    // at their own natural size — set m.scale and m.position so they fit your
    // scene") was an instruction to GUESS, and the model duly guessed 10 m for
    // a 1 m road tile, scattering the track across a field of grass. It now
    // teaches modelSize(name) — measured metres, shipped in window.AR_SIZES —
    // and to step tiles by that exact footprint. ~50 tokens of fault-driven
    // teaching that also DELETES the wrong teaching it replaces, the same
    // category as the 2300 → 2350 rotor raise. Measured 2398 — deliberately
    // close to the line, because the next raise should have to justify itself.
    // The category-map hybrid the section doc promises is still the next step
    // if an ASSET BATCH pushes past this line — it is not a licence to keep
    // raising it for prose.
    //
    // 2400 → 2450 (2026-08-08, BUG-FIX-LOG "poorly formed race track"). Same
    // category as the 2300 → 2350 rotor raise and the 2350 → 2400 modelSize
    // one: fault-driven teaching that DELETES the wrong teaching it replaces.
    // Rule 4 asserted "Every model faces +Z at rest" as a universal — TRUE of
    // the racing kit, FALSE of the city kit, whose road_straight runs along X.
    // A 1×1 m square tile's size cannot reveal the difference, so the model
    // rotated every city tile 90° wrong and no re-prompt could fix it. The
    // replacement teaches modelAxis() and costs +39 tokens net after rule 4
    // was compressed to pay for most of it. Measured 2437.
    //
    // 2450 → 2525 (2026-08-09, BUG-FIX-LOG the SECOND "poorly formed race
    // track"). THE THIRD CONSECUTIVE FAULT-DRIVEN RAISE, and the first that
    // could not pay for itself by deleting wrong teaching — flagged to the
    // owner rather than taken silently, because a ceiling raised whenever it
    // binds is not a ceiling.
    //
    // What it buys: modelJoins() and rotateToJoin(). modelAxis() (the 2400 →
    // 2450 raise) fixed the STRAIGHTS and answers 'none' for every corner —
    // true, and no help at all in placing one. With nothing else to reason
    // from, the generated track guessed corner rotations 0, -pi/2, pi, pi/2,
    // and the curves never met the straights. It also teaches one kit at one
    // scale factor: the same game scaled finish_line x10 while scaling its
    // straights x20, producing a 7 m gantry over a 20 m road.
    //
    // Rule 4 was compressed first and absorbed ~35 of the ~112 tokens; +77
    // net. Measured 2514.
    //
    // THE NEXT RAISE SHOULD NOT HAPPEN. Three raises in three days is the
    // signal the section doc predicted: the fix is the category-map hybrid
    // (teach the RULES, look the CATALOG up on demand), not more prose. Layer
    // 2 golden prompts (PRD §4) is what would catch a regression here without
    // spending another token.
    expect(Math.ceil(section.length / 4)).toBeLessThanOrEqual(2_900);
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

describe("the sports category (2026-07-26 batch) renders in the real catalog", () => {
  const section = modelsPromptSection(realManifest as AssetManifest);

  // Post-hybrid (2026-08-09) these ask the question that actually matters to a
  // child: does asking for the game GET you the set? The heading is now a
  // count, so a name assertion against the section would pin nothing.
  it("a football ask retrieves the soccer set and the battle tops", () => {
    const names = retrievedModelNames({ message: "make a football game", history: [], manifest: realManifest as AssetManifest });
    expect(names).toContain("soccer_ball");
    expect(names).toContain("battle_top");
    expect(names).toContain("blade_top");
  });

  it("has a sports category in the map", () => {
    expect(section).toMatch(/sports[^\n]*: \d+/);
  });

  it("the footballers are taught as people-rig models (their clips promise must hold)", () => {
    expect(section).toMatch(/people models \([^)]*footballer\b/);
  });
});

describe("the military category (2026-07-29 batch) renders in the real catalog", () => {
  const section = modelsPromptSection(realManifest as AssetManifest);

  it("has a military category in the map (the heading is the genre LABEL, not its id)", () => {
    expect(section).toMatch(/army \/ battle vehicles: \d+/);
  });

  it("an army ask retrieves the tanks AND the fortifications, not just the vehicles", () => {
    const names = retrievedModelNames({ message: "make an army battle game", history: [], manifest: realManifest as AssetManifest });
    for (const name of ["tank", "tank_desert", "tank_toy", "turret", "sandbags", "bunker", "watchtower", "barricade"]) {
      expect(names, `army ask did not retrieve ${name}`).toContain(name);
    }
  });

  it("teaches the soldiers' OWN clip names, and says they are not the people clips", () => {
    expect(section).toMatch(/soldier models \([^)]*\bsoldier\b/);
    expect(section).toMatch(/Run_Gun/);
    expect(section).toMatch(/Idle_Shoot/);
    expect(section).toMatch(/do NOT have the people clips/i);
  });

  it("never promises a walk clip — soldier has none, only hazmat does", () => {
    // The union of two rig-mates is NOT the promise; the intersection is.
    // `soldier` ships Idle/Run/Run_Gun/Idle_Shoot/Jump/Jump_Idle/Wave/Death
    // and no Walk, so teaching "walk" would send the model looking for a clip
    // that half the set lacks (verified against the staged GLBs, 2026-07-29).
    const soldierClause = section.match(/The soldier models[\s\S]*?soldier\)\.add\(gun\)[^.]*\./)?.[0] ?? "";
    expect(soldierClause).not.toBe("");
    // The property is that Walk is never OFFERED as an available clip — the
    // clause naming it in a negation ("there is no walk clip") is the point,
    // so assert on the advertised clip list, not on the word appearing at all.
    const advertised = soldierClause.match(/they carry ([^.]*)\./)?.[1] ?? "";
    expect(advertised).toMatch(/Run_Gun/);
    expect(advertised).not.toMatch(/\bwalk\b/i);
    expect(soldierClause).toMatch(/no walk clip/i);
    // \s+ between words: the prompt is a wrapped template literal and a
    // re-wrap must not break this pin (same convention as the import test).
    expect(soldierClause).toMatch(/Use\s+Run\s+for\s+ALL\s+movement/);
  });

  it("tells the model the clip names are armature-prefixed, so search don't string-match", () => {
    expect(section).toMatch(/CharacterArmature\|Run/);
    expect(section).toMatch(/never by exact string/i);
  });

  it("tells the model the weapons are separate objects, parented to the lower arm not the root", () => {
    expect(section).toMatch(/weapons are SEPARATE models/i);
    expect(section).toMatch(/parent\s+to\s+the\s+lower\s+arm,\s+not\s+the\s+root/i);
    expect(section).toMatch(/soldier\)\.add\(gun\)/);
  });

  it("the soldiers are NOT on the Kenney people clip line (different rig, different clips)", () => {
    const peopleLine = section.match(/people models \(([^)]*)\)/)?.[1] ?? "";
    expect(peopleLine).not.toMatch(/\bsoldier\b/);
    expect(peopleLine).not.toMatch(/\bhazmat\b/);
  });

  it("none of the military vehicles is taught as a people-rig model (no walk clip to promise)", () => {
    const peopleLine = section.match(/people models \(([^)]*)\)/)?.[1] ?? "";
    for (const name of ["tank", "turret", "bunker", "armored_truck"]) {
      expect(peopleLine).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

describe("the indian games category (2026-07-30 batch) renders in the real catalog", () => {
  const section = modelsPromptSection(realManifest as AssetManifest);

  it("a carrom/ludo/kabaddi ask retrieves the whole set (genres are the unit of selection)", () => {
    const names = retrievedModelNames({ message: "let us play carrom", history: [], manifest: realManifest as AssetManifest });
    for (const name of [
      "kabaddi_mat", "carrom_board", "carrom_striker", "carrom_coin_white", "carrom_queen",
      "kho_kho_pole", "kho_kho_lane_field", "badminton_racket", "shuttlecock", "badminton_net",
      "ludo_board", "ludo_dice", "ludo_pawn_red", "ludo_pawn_blue", "marble", "marble_blue",
    ]) {
      expect(names, `carrom ask did not retrieve ${name}`).toContain(name);
    }
  });

  it("has an indian-games category in the map", () => {
    expect(section).toMatch(/Indian games: \d+/);
  });

  it("kabaddi_player and kho_kho_player are taught as people-rig models (their clips promise must hold)", () => {
    expect(section).toMatch(/people models \([^)]*kabaddi_player\b/);
    expect(section).toMatch(/people models \([^)]*kho_kho_player\b/);
  });
});

// The sports playbook (owner ask 2026-07-26): models alone produce the
// "everyone chases the ball" game — the LLM needs the basic rules and the
// team-AI pattern. Static (derived from the manifest, not the message), so
// the byte-stability test below still holds and prefix caching survives.
describe("the sports playbook teaches rules + dynamics, cache-safely", () => {
  const section = modelsPromptSection(realManifest as AssetManifest);

  it("teaches the object of a team sport (score in the OPPONENT's goal, restart, win condition)", () => {
    expect(section).toMatch(/opponent'?s goal/i);
    expect(section).toMatch(/restart|centre|center/i);
    expect(section).toMatch(/score/i);
  });

  it("bans the ball-swarm: one chaser, everyone else holds formation", () => {
    expect(section).toMatch(/not .*every(one| player).*chase|only the (one|closest)/i);
    expect(section).toMatch(/formation|home (spot|position)/i);
  });

  it("clamps the goalkeeper to the goal mouth", () => {
    expect(section).toMatch(/goal\s?keeper|keeper/i);
    expect(section).toMatch(/clamp/i);
  });

  it("teaches kick-as-impulse with friction, never a physics engine", () => {
    expect(section).toMatch(/impulse|velocity/i);
    expect(section).toMatch(/friction|slow(s|ing)? (down|by)/i);
    expect(section).toMatch(/no physics engine/i);
  });

  it("covers duel games separately (air hockey paddles, battle-top spin decay)", () => {
    expect(section).toMatch(/air hockey/i);
    expect(section).toMatch(/own half/i);
    expect(section).toMatch(/spin/i);
    expect(section).toMatch(/decay|slows|loses/i);
  });

  it("generalizes beyond football (hockey / polo use a hit clip, not the kick)", () => {
    expect(section).toMatch(/hockey/i);
    expect(section).toMatch(/polo/i);
  });

  it("renders NOTHING for a manifest without sports models (zero tokens for non-sports libraries)", () => {
    const noSports = modelsPromptSection(fakeModels);
    expect(noSports).not.toMatch(/TEAM SPORT/i);
    expect(noSports).not.toMatch(/air hockey/i);
  });
});

describe("catalog scale ceilings (PRD §14, amended 2026-07-24: teach-everything)", () => {
  it("the committed manifest stays under a sanity ceiling (revisit selection priorities at the next doubling)", () => {
    // Bumped 60 → 120 (2026-07-14): the catalog doubled 50 → 100 (city models,
    // race-track pieces, dragons). Selection priorities WERE revisited as part
    // of this bump — see model-select.ts GENRES, extended the same day to
    // route every new model through a genre trigger, not just name-literal
    // matching.
    //
    // Bumped 120 → 320 (2026-07-24), the deliberate decision this test exists
    // to force. What changed: the prompt no longer teaches a per-message
    // SUBSET, it teaches the whole library grouped by category, so "selection
    // priorities" are no longer the thing at risk — the TOKEN CEILING is.
    // That is now pinned directly by the token-ceiling test above (≤1,500),
    // which is a tighter and more honest guard than a model count. This
    // number stays only as a tripwire against an accidental bulk import.
    //
    // Bumped 320 → 400 (2026-08-09, the animals/rivers/snow batch took the
    // library to 322). Deliberate, and the honest reason it is now SAFE to
    // raise: the category-map hybrid landed in the same change, so model
    // NAMES no longer enter the system prompt at all. Library size and prompt
    // size are decoupled for the first time — the growth this tripwire was
    // guarding no longer costs a byte of cached prefix. What still needs
    // watching is per-turn retrieval breadth, and that is pinned directly by
    // "a no-trigger ask still sees every category". 400 keeps the
    // accidental-bulk-import tripwire meaningful without re-tripping on every
    // curated batch.
    const models = realManifest.assets.filter((a) => a.type === "model");
    expect(models.length).toBeLessThanOrEqual(400);
  });
});

// BUG-FIX-LOG 2026-08-06 ("the sideways black bike"): a model's rest
// orientation is invisible to the LLM, so the library's facing convention
// must be TAUGHT globally (one line, ~15 tokens) and ENFORCED at curation
// (vendor-models.mjs orientation lint) — never patched per-model in games.
describe("the facing convention is taught (2026-08-06)", () => {
  // SUPERSEDED 2026-08-08 (BUG-FIX-LOG "poorly formed race track"). The old
  // pin demanded the section assert "+Z is forward" for EVERY model — which is
  // exactly the falsehood that broke every road build: the city kit's
  // road_straight runs along X. The facing rule is now scoped to
  // vehicles/characters, and tiles get modelAxis() instead.
  it("never claims a blanket facing, and teaches modelFacing/placeModel instead", () => {
    // 2026-08-15: the prompt used to assert "VEHICLES/CHARACTERS face +Z"
    // unconditionally. A top-down render audit disproved it — `car` faces -Z
    // (180 degrees out) and `airplane` faces +X (90 degrees out), while
    // `crocodile` and `dog` do face +Z. A bounding box cannot express a
    // direction, so before AR_FACING there was no datum anywhere that could
    // tell a game which way a model points, and every game re-guessed it
    // (TECH_DEBT #91: wrong-facing models recurring across unrelated games).
    const section = modelsPromptSection(realManifest as AssetManifest);
    expect(section).toContain("modelFacing(name)");
    expect(section).toContain("placeModel");
    // modelAxis() was tile-only guidance and went with the kit (2026-08-15).
    expect(section).not.toContain("modelAxis(name)");
    // Neither blanket claim may come back — both were false.
    expect(section).not.toMatch(/Every model faces \+Z/);
    expect(section).not.toMatch(/VEHICLES\/CHARACTERS face \+Z/);
  });

  it("does not call the catalog's own units REAL metres, and teaches modelMetres", () => {
    // The other half of the same report: 238 of 296 sized models are raw kit
    // units, not metres, so `modelSize` alone makes a mountain (1.9) smaller
    // than a car (2.56). Calling it "REAL metres" is what let the model size a
    // whole scene from it.
    const section = modelsPromptSection(realManifest as AssetManifest);
    expect(section).toContain("modelMetres(name)");
    expect(section).not.toMatch(/modelSize\(name\)` gives REAL metres/);
  });
});

// ── the category-map hybrid (2026-08-09) ────────────────────────────────────
// docs/2026-08-09_PRD_AnimalsSnowSkiAssets.md §3. The static catalog's own note
// promised this fallback from the day it was written and three ceiling raises
// deferred it; the animals/snow batch (+38 names) is what finally forced it.
// These pin the two properties that make the trade safe: the model can still
// SEE the whole library (counts), and retrieval is generous enough that the
// 2026-07-24 "taught 6 of 106 models" regression cannot come back.
describe("the category-map hybrid — retrieval", () => {
  const real = realManifest as AssetManifest;

  it("a triggered genre arrives WHOLE (genres are the unit of selection)", () => {
    const names = retrievedModelNames({ message: "make a skiing game", history: [], manifest: real });
    for (const n of ["skis", "ski_poles", "slalom_gate", "chairlift", "snow_pine", "mountain"]) {
      expect(names, `ski ask did not retrieve ${n}`).toContain(n);
    }
  });

  it("a child who names a model outright always gets that model", () => {
    expect(retrievedModelNames({ message: "a game with a crocodile", history: [], manifest: real })).toContain("crocodile");
  });

  it("THE 2026-07-24 REGRESSION: a no-trigger ask still sees every category", () => {
    // "make me a fun game" triggered nothing, so the old selection taught 6 of
    // 106 models and the model hand-rolled cubes for a pizza restaurant while
    // 19 food models sat unused. The spread is what makes that impossible.
    const names = retrievedModelNames({ message: "make me a fun game", history: [], manifest: real });
    for (const genre of GENRE_IDS) {
      const members = modelsInGenre(genre, new Set(real.assets.filter((a) => a.type === "model").map((a) => a.name)));
      if (members.length === 0) continue;
      expect(
        members.some((m) => names.includes(m)),
        `a no-trigger turn sees nothing from "${genre}" — the pizza-restaurant bug is back`,
      ).toBe(true);
    }
  });

  it("keeps the models the CURRENT GAME already uses, or the model could not maintain its own game", () => {
    const history: ChatMessage[] = [
      { id: "m1", createdAt: 1, role: "child", text: "a racing game" },
      { id: "m2", createdAt: 2, role: "assistant", text: "here", artifactHtml: "<!--USES_MODELS: elephant,igloo--><html></html>" },
    ];
    const names = retrievedModelNames({ message: "make it faster", history, manifest: real });
    expect(names).toContain("elephant");
    expect(names).toContain("igloo");
  });

  it("never invents a name — everything retrieved is in the manifest", () => {
    const available = new Set(real.assets.filter((a) => a.type === "model").map((a) => a.name));
    const names = retrievedModelNames({ message: "dogs and dragons and skiing", history: [], manifest: real });
    for (const n of names) expect(available.has(n), `retrieved "${n}" is not in the manifest`).toBe(true);
  });
});

describe("the category-map hybrid — the block that rides at the end of the contents", () => {
  it("renders sorted and deterministic (a stable block is a cacheable block)", () => {
    expect(modelNamesBlock(["dino", "car"])).toBe(modelNamesBlock(["car", "dino"]));
    expect(modelNamesBlock(["dino", "car"])).toMatch(/car, dino/);
  });

  it("repeats the never-invent rule where the names actually are", () => {
    expect(modelNamesBlock(["car"])).toMatch(/never invent a name/i);
  });

  it("is empty for an empty selection (zero tokens, never a dangling label)", () => {
    expect(modelNamesBlock([])).toBe("");
  });
});

describe("the prompt never teaches a three import the bundle lacks (2026-08-16)", () => {
  it("names the curve classes as FORBIDDEN, since the bundle does not export them", () => {
    // The Village Turbo Racer failure: the model reached for CatmullRomCurve3
    // to lay out a road, which is not exported, so the module failed to parse
    // and the child's Start button did nothing.
    const section = modelsPromptSection(realManifest as AssetManifest);
    expect(section).toMatch(/no curve class/i);
    expect(section).toContain("CatmullRomCurve3");
    // and it must say so as a prohibition, not as a suggestion to use it
    expect(section).toMatch(/NO curve class in this build/);
  });
});
