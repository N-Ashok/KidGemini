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

  it("names every manifest model and nothing else", () => {
    expect(section).toContain("car");
    expect(section).toContain("dino");
    // Models are listed under category headings, each exactly once.
    expect(section).toMatch(/racing[^:]*: car/);
    expect(section).toMatch(/animals[^:]*: dino/);
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

  describe("category grouping — lockstep with the manifest", () => {
    it("groups models under their category heading", () => {
      // fakeModels has car + dino only: racing shows car, animals shows dino…
      expect(section).toMatch(/racing[^:]*: car/);
      expect(section).toMatch(/animals[^:]*: dino/);
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
  const realModels = real.assets.filter((a) => a.type === "model").map((a) => a.name);
  const section = modelsPromptSection(real);

  it("names every single model in the manifest", () => {
    const missing = realModels.filter((n) => !new RegExp(`\\b${n}\\b`).test(section));
    expect(missing).toEqual([]);
  });

  it("lists each model exactly once across the category block (cross-listing spends tokens to repeat what the model already read)", () => {
    // Scope to the index itself — the usage steps below it legitimately repeat
    // one name as the worked example (USES_MODELS + loadModel).
    const index = section.split("\n1. Add a second marker")[0]!;
    for (const name of realModels) {
      const hits = index.match(new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`, "g")) ?? [];
      expect(hits.length, `${name} listed ${hits.length}x in the category block`).toBe(1);
    }
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
    expect(Math.ceil(section.length / 4)).toBeLessThanOrEqual(2_300);
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

  it("has a sports heading naming the soccer set and the battle tops", () => {
    expect(section).toMatch(/sports[^\n]*: [^\n]*soccer_ball/);
    expect(section).toMatch(/\bbattle_top\b/);
    expect(section).toMatch(/\bblade_top\b/);
  });

  it("the footballers are taught as people-rig models (their clips promise must hold)", () => {
    expect(section).toMatch(/people models \([^)]*footballer\b/);
  });
});

describe("the military category (2026-07-29 batch) renders in the real catalog", () => {
  const section = modelsPromptSection(realManifest as AssetManifest);

  it("has a military heading naming the tanks", () => {
    // The heading is the genre LABEL ("army / battle vehicles"), not its id.
    expect(section).toMatch(/army \/ battle vehicles: [^\n]*\btank\b/);
    expect(section).toMatch(/\btank_desert\b/);
    expect(section).toMatch(/\btank_toy\b/);
  });

  it("teaches the fortifications too, not just the vehicles", () => {
    for (const name of ["turret", "sandbags", "bunker", "watchtower", "barricade"]) {
      expect(section).toMatch(new RegExp(`\\b${name}\\b`));
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

  it("has an indian-games heading naming the kabaddi/carrom/kho-kho/badminton/ludo/marbles sets", () => {
    for (const name of [
      "kabaddi_mat", "carrom_board", "carrom_striker", "carrom_coin_white", "carrom_queen",
      "kho_kho_pole", "kho_kho_lane_field", "badminton_racket", "shuttlecock", "badminton_net",
      "ludo_board", "ludo_dice", "ludo_pawn_red", "ludo_pawn_blue", "marble", "marble_blue",
    ]) {
      expect(section).toMatch(new RegExp(`\\b${name}\\b`));
    }
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
    const models = realManifest.assets.filter((a) => a.type === "model");
    expect(models.length).toBeLessThanOrEqual(320);
  });
});

// BUG-FIX-LOG 2026-08-06 ("the sideways black bike"): a model's rest
// orientation is invisible to the LLM, so the library's facing convention
// must be TAUGHT globally (one line, ~15 tokens) and ENFORCED at curation
// (vendor-models.mjs orientation lint) — never patched per-model in games.
describe("the facing convention is taught (2026-08-06)", () => {
  it("tells the model everything faces +Z and rotation.y alone steers", () => {
    const section = modelsPromptSection(realManifest as AssetManifest);
    expect(section).toContain("faces +Z at rest");
    expect(section).toContain("rotation.y");
    expect(section).toContain("+Z is forward");
  });
});
