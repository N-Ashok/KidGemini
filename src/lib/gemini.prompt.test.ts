// Pins the child-safety system prompt that REPLACED the Flash-Lite output
// monitor (2026-07-09). If these lines disappear, the chat model loses its
// only per-generation child-safety instruction — that must fail loudly here.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CHILD_SYSTEM_PROMPT, buildTurnSystemInstruction } from "./gemini";
import { THREE_PROMPT_SECTION } from "./assets/prompt-catalog";
import { PHYSICS_PROMPT_SECTION, physicsEnginePromptSection } from "./assets/physics-playbook";

describe("CHILD_SYSTEM_PROMPT (safety instruction, monitor replacement)", () => {
  it("states the audience is a child aged 7 to 14", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/child aged between 7 and 14/i);
  });
  it("carries the be-careful / be-cautious safety instruction", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/careful in the way you speak/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/cautious about safety/i);
  });
  it("forbids unsafe content and never refuses a game", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never produce anything scary, gory, sexual, hateful, or unsafe/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never refuse a game request/i);
  });
  it("never deflects a hard game to a simpler one (chess-deflection class, 2026-07-09)", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never (say|call) (a game is|it) too (complicated|complex|hard)/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/build the game the child asked for/i);
  });
  it("allows trusted CDN libraries for rule-heavy classics like chess", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/chess\.js/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/cdn/i);
  });

  // Self-healing preview batch (PRD §10 + TECH_DEBT #22, 2026-07-10): the
  // playability contract. These are prompt rules, not probes — a game that
  // kills the player at spawn runs "perfectly" and no probe can catch it.
  it("mandates the game loop start immediately and synchronously on load (async-loop class)", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/immediately and synchronously/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never wrap .* async|not .* async function/i);
  });
  it("gives the player a 3-second grace period before any hazard", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/first 3 seconds/i);
  });
  it("requires safe spawn distance and an escape move", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never overlapping|safe distance/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/escape/i);
  });
  it("requires difficulty to ramp gently", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/starts? slow|first .* slow/i);
  });
  it("commits to one interpretation on vague asks — no option-weighing burn (2026-07-11)", () => {
    // \s+ between words: the prompt is a wrapped template literal and a
    // re-wrap must not break this pin.
    expect(CHILD_SYSTEM_PROMPT).toMatch(/vague\s+or\s+open-ended/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/pick\s+one\s+fun,\s+concrete\s+interpretation/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/start\s+(building|coding)\s+(it\s+)?immediately/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/do\s+not\s+list\s+options\s+or\s+ask\s+which/i);
  });

  // 2026-07-22: heavy content-generation asks (a pastor's Bible game — "100 real
  // New Testament names, 80 followers") made the model STOP EARLY on a half-
  // written file, not for size (3D games generate far more and finish) but on
  // the factual-recall + finish-the-document task. Steer it to finish and to
  // stay honest about facts. \s+ tolerates the wrapped template literal.
  it("tells the model to output a COMPLETE document ending in </html>, using compact data arrays", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/COMPLETE\s+HTML\s+document/);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/ending\s+with\s*\n?\s*<\/html>/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/JavaScript\s+ARRAY\s+and\s+loop\s+over\s+it/i);
  });

  it("forbids inventing real-world facts/names — accurate set over a padded, made-up one", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never\s+invent\s+or\s+make\s+up\s+names\s+or\s+facts/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/smaller\s+ACCURATE\s+set\s+is\s+always\s+better/i);
  });

  // KNOWN_BUGS #5 class fix (2026-07-27): 84% of real prod full-rebuild
  // triggers were search_not_found on ordinary small edits — the model
  // couldn't re-locate a plain code chunk it had to transcribe from memory.
  // Landmark comments give edit turns a short, distinctive anchor to search
  // for instead of a large exact block, so this instructs it at BUILD time
  // (see GAME_EDIT_PROMPT_SECTION in game-edit.test.ts for the edit-side half).
  it("instructs the model to sprinkle short landmark comments across distinct code sections", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/landmark comment/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/short,\s*distinct/i);
  });
});

describe("edit turns carry a slimmer prompt (2026-08-16)", () => {
  // Owner: "i want edit prompt to be simpler rather than the same 7200 token".
  const g3 = { three: true, audio: false, save: false, physics: false };

  it("a fresh build gets the renderer bootstrap; an edit does not", () => {
    // THREE_PROMPT_SECTION teaches how to STAND UP a renderer, size the canvas
    // and light the scene. On an edit that renderer already exists in the code
    // the model is reading, so re-teaching it costs ~1,000 tokens a turn to
    // describe what the game already does.
    const build = buildTurnSystemInstruction(g3, false, false, false, "default", true);
    const edit = buildTurnSystemInstruction(g3, false, true, false, "default", true);
    expect(build).toContain(THREE_PROMPT_SECTION);
    expect(edit).not.toContain(THREE_PROMPT_SECTION);
  });

  it("but an edit KEEPS the model/placement rules — edits add and move props", () => {
    const edit = buildTurnSystemInstruction(g3, false, true, false, "default", true);
    expect(edit).toContain("placeModel");
    expect(edit).toContain("modelHeading");
    expect(edit).toContain("SCENERY GOES WHERE THE PLAYER GOES");
  });

  it("and an edit KEEPS movement feel, which is not renderer bootstrap", () => {
    const edit = buildTurnSystemInstruction(g3, false, true, false, "default", true);
    expect(edit).toContain(PHYSICS_PROMPT_SECTION);
  });

  it("the cannon-es engine playbook rides only when physics is gated on", () => {
    const off = buildTurnSystemInstruction(g3, false, true, false, "default", true);
    const on = buildTurnSystemInstruction({ ...g3, physics: true }, false, true, false, "default", true);
    expect(on.length).toBeGreaterThan(off.length);
    expect(on).toContain(physicsEnginePromptSection());
  });

  it("an edit turn is materially smaller than a first build", () => {
    const build = buildTurnSystemInstruction(g3, false, false, false, "default", true);
    const edit = buildTurnSystemInstruction(g3, false, true, false, "default", true);
    // It still carries the patch contract, so it is not free — but the
    // bootstrap it drops is bigger than the contract it adds.
    expect(edit.length).toBeLessThan(build.length);
  });
});
