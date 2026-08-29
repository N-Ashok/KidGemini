// Pins the child-safety system prompt that REPLACED the Flash-Lite output
// monitor (2026-07-09). If these lines disappear, the chat model loses its
// only per-generation child-safety instruction — that must fail loudly here.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CHILD_SYSTEM_PROMPT, CHILD_SAFETY_CORE, CHILD_BUILD_RULES, EDIT_CRAFT_RULES, buildTurnSystemInstruction } from "./gemini";
import { REPEATED_REQUEST_SECTION } from "./game-edit";
import { THREE_EDIT_CHEATSHEET, audioPromptSection } from "./assets/prompt-catalog";
import { SAVE_STATE_PROMPT_SECTION } from "./assets/save-state-playbook";
import { MULTIPLAYER_PROMPT_SECTION } from "./multiplayer-prompt";
import { NEXT_ASK_EDIT_PROMPT_SECTION } from "./next-ask-sentinel";
import { PROCGEN_PROMPT_SECTION } from "./assets/procgen-playbook";
import { GAME_FEEL_PROMPT_SECTION } from "./assets/game-feel-playbook";

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

  // 2026-08-27 (owner): most generated games were "explore with no goal" —
  // no way to win, no way to lose, nothing changes as you play. The build
  // contract now asks for a mission (win + lose), choices/rewards, and
  // levels that get harder, taught by EXAMPLE rather than as a fixed recipe.
  describe("game-design guidance — a game needs a mission, choices and rising difficulty (2026-08-27)", () => {
    it("GD.1 requires a clear way to WIN and a way to LOSE, with a game-over/win screen and replay", () => {
      expect(CHILD_SYSTEM_PROMPT).toMatch(/clear\s+way\s+to\s+WIN\s+and\s+a\s+way\s+to\s+LOSE/);
      expect(CHILD_SYSTEM_PROMPT).toMatch(/play\s+again/i);
    });
    it("GD.2 asks for choices and rewards (risky path / power-ups) as examples", () => {
      expect(CHILD_SYSTEM_PROMPT).toMatch(/safe\s+way\s+and\s+a\s+fun\s+way/i);
      expect(CHILD_SYSTEM_PROMPT).toMatch(/power-ups?/i);
    });
    it("GD.3 asks for levels or stages that get a little harder, e.g. a final challenge/boss", () => {
      expect(CHILD_SYSTEM_PROMPT).toMatch(/a\s+little\s+harder/i);
      expect(CHILD_SYSTEM_PROMPT).toMatch(/boss/i);
    });
    it("GD.3b three levels is only an example — levels live in a LEVELS array so a child can grow the game (toward 50) in later asks", () => {
      expect(CHILD_SYSTEM_PROMPT).toMatch(/three\s+levels\s+is\s+only\s+an\s+example/i);
      expect(CHILD_SYSTEM_PROMPT).toMatch(/grow\s+to\s+50/i);
      expect(CHILD_SYSTEM_PROMPT).toMatch(/LEVELS\s+data\s+array/);
      expect(CHILD_SYSTEM_PROMPT).toMatch(/ask\s+for\s+more\s+levels/i);
    });
    it("GD.4 examples cover the bad-guys / enemies genre, kept bloodless (owner ask)", () => {
      expect(CHILD_SYSTEM_PROMPT).toMatch(/bad\s+guys/i);
    });
    it("GD.5 the guidance is framed as examples, not the child's request verbatim", () => {
      expect(CHILD_SYSTEM_PROMPT).toMatch(/for\s+example|e\.g\./i);
      expect(CHILD_SYSTEM_PROMPT).toMatch(/fit\s+.*\s+to\s+the\s+game\s+the\s+child\s+asked\s+for/i);
    });
  });
});

// 2026-08-25 PRD_EditTurnCost §4.A (PRD-PROMPT-CACHING Fix C): the system
// instruction is the first bytes of every request. Anything per-turn in it
// invalidates the whole cache from byte 0. The repeated-request directive was
// the last per-turn section still living here — it now rides the tail.
describe("buildTurnSystemInstruction — no per-turn bytes (cache prefix stability)", () => {
  const gates = { three: true, threeReason: "asked" as const, audio: true, save: true };

  it("S.1 is byte-identical across two consecutive edit turns with the same gates", () => {
    const a = buildTurnSystemInstruction(gates, true, true, false, "default", true);
    const b = buildTurnSystemInstruction(gates, true, true, false, "default", true);
    expect(a).toBe(b);
  });

  it("S.2 a repeated request no longer changes the instruction (the directive rides the tail instead)", () => {
    const plain = buildTurnSystemInstruction(gates, true, true, false, "default", true);
    const repeated = buildTurnSystemInstruction(gates, true, true, true, "default", true);
    expect(repeated).toBe(plain);
    expect(plain).not.toContain(REPEATED_REQUEST_SECTION);
  });
});

// 2026-08-25 (noble-orbiting-stallman step 3): an EDIT turn gets an edit-sized
// instruction — the child-safety core + edit craft rules + a 3D cheat sheet —
// instead of the full build playbooks (~7.7k → ~2.5k tokens). Build turns are
// byte-identical to before. Owner decision 2026-08-25 on exactly what stays.
describe("edit-turn instruction (slim) vs build-turn instruction (unchanged)", () => {
  const gates = { three: true, threeReason: "asked" as const, audio: false, save: true };

  it("ED.1 the build instruction still starts with the full CHILD_SYSTEM_PROMPT, byte-identical", () => {
    const build = buildTurnSystemInstruction(gates, false, false, false, "default", true);
    expect(build.startsWith(CHILD_SYSTEM_PROMPT)).toBe(true);
    expect(CHILD_SYSTEM_PROMPT).toBe(`${CHILD_SAFETY_CORE}\n${CHILD_BUILD_RULES}`); // the split changes no bytes
  });

  it("ED.2 the edit instruction keeps the safety core and drops the build-only rules", () => {
    const edit = buildTurnSystemInstruction(gates, false, true, false, "default", true);
    expect(edit).toContain(CHILD_SAFETY_CORE);
    expect(edit).toContain(EDIT_CRAFT_RULES);
    for (const buildOnly of ["chess.js", "make something cool", "single HTML document wrapped", "pointerdown/touchstart", "100dvh", "JavaScript ARRAY"]) {
      expect(edit, buildOnly).not.toContain(buildOnly);
    }
  });

  it("ED.3 safety lines are present on BOTH shapes (rule 3 — never removed)", () => {
    for (const isEdit of [false, true]) {
      const s = buildTurnSystemInstruction(gates, false, isEdit, false, "default", true);
      expect(s).toMatch(/child aged between 7 and 14/);
      expect(s).toMatch(/scary, gory, sexual, hateful, or unsafe/);
      expect(s).toMatch(/never refuse a game request/);
      expect(s).toMatch(/bloodless and playful/);
    }
  });

  // 2026-08-27: an edit must not strip the game's mission/levels, but must NOT
  // rewrite a small ask ("make the car red") into a 3-level game either — so
  // the edit shape gets a one-line PRESERVE rule, never the full design guidance.
  it("ED.10 edit preserves existing win/lose + levels; only adds them on ask or when the game has none — and never the full build design examples", () => {
    const edit = buildTurnSystemInstruction(gates, false, true, false, "default", true);
    expect(edit).toMatch(/keep\s+the\s+game'?s\s+existing\s+goal/i);
    expect(edit).toMatch(/no\s+way\s+to\s+win\s+or\s+lose/i);
    expect(edit).not.toMatch(/safe\s+way\s+and\s+a\s+fun\s+way/i);
    expect(edit).not.toMatch(/silly,\s+friendly\s+boss/i);
  });

  it("ED.11 edit WELCOMES growing the game — more levels / harder level / new boss go into the LEVELS array, never a rebuild", () => {
    const edit = buildTurnSystemInstruction(gates, false, true, false, "default", true);
    expect(edit).toMatch(/asks\s+for\s+more\s+levels/i);
    expect(edit).toMatch(/LEVELS\s+array/);
    expect(edit).toMatch(/never\s+rebuild\s+the\s+game\s+to\s+add\s+a\s+level/i);
  });

  it("ED.4 edit keeps: landmark comments, keep-controls line, the edit contract, next-ask", () => {
    const edit = buildTurnSystemInstruction(gates, false, true, false, "default", true);
    expect(edit).toMatch(/landmark/i);
    expect(edit).toMatch(/id="score"/);
    expect(edit).toContain("<<<<<<< SEARCH");
    expect(edit).toContain(NEXT_ASK_EDIT_PROMPT_SECTION);
  });

  it("ED.5 edit replaces the 3D/physics/catalog playbooks with the cheat sheet, and drops the save playbooks", () => {
    const edit = buildTurnSystemInstruction(gates, false, true, false, "default", true);
    expect(edit).toContain(THREE_EDIT_CHEATSHEET);
    expect(edit).not.toMatch(/SOLID THINGS/); // physics playbook
    expect(edit).not.toMatch(/Here is what the toy box HOLDS/); // full catalog
    expect(edit).not.toContain(SAVE_STATE_PROMPT_SECTION); // gates.save is a BUILD gate
    expect(edit.length).toBeLessThan(12000); // ~3k tokens
  });

  it("ED.6 an edit whose ask introduces a subsystem gets that section back (editGates)", () => {
    const withAudio = buildTurnSystemInstruction(gates, false, true, false, "default", true, { audio: true });
    expect(withAudio).toContain(audioPromptSection());
    const withSave = buildTurnSystemInstruction(gates, false, true, false, "default", true, { save: true });
    expect(withSave).toContain(SAVE_STATE_PROMPT_SECTION);
    const withModels = buildTurnSystemInstruction(gates, false, true, false, "default", true, { models: true });
    expect(withModels).toMatch(/Here is what the toy box HOLDS/);
    const withPhysics = buildTurnSystemInstruction(gates, false, true, false, "default", true, { physics: true });
    expect(withPhysics).toMatch(/SOLID THINGS/);
    const withMp = buildTurnSystemInstruction(gates, false, true, false, "default", true, { multiplayer: true });
    expect(withMp).toContain(MULTIPLAYER_PROMPT_SECTION);
  });

  it("ED.7 a 2D edit is just core + craft + edit contract (+ next-ask)", () => {
    const edit = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false, true, false, "default", true);
    expect(edit).not.toContain(THREE_EDIT_CHEATSHEET);
    // 5,184 -> 6,366 chars on 2026-08-29 when the always-on game-feel section
    // joined edit turns (+296 tok, ~₹0.6/day at current volume). Kept because
    // the owner's complaint was itself an edit. Ceiling 7,000: past that, the
    // slim-edit instruction has stopped being slim — cut content, do not raise.
    expect(edit.length).toBeLessThan(7000);
  });

  it("ED.9 EDIT_INSTRUCTION_V2=off restores the full build prompt on edits (rollback switch)", () => {
    vi.stubEnv("EDIT_INSTRUCTION_V2", "off");
    try {
      const edit = buildTurnSystemInstruction(gates, false, true, false, "default", true);
      expect(edit.startsWith(CHILD_SYSTEM_PROMPT)).toBe(true);
      expect(edit).toContain(SAVE_STATE_PROMPT_SECTION);
      expect(edit).not.toContain(THREE_EDIT_CHEATSHEET);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ED.8 the bible-teacher persona is untouched on edits (its own base prompt, as before)", () => {
    const edit = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false, true, false, "bible-teacher", true);
    expect(edit).toMatch(/Sunday-school/);
  });
});

// 2026-08-28 (owner idea): landmarks now carry a one-line summary of what the
// section does, so an EDIT turn can be shown a table of contents plus only the
// sections it needs (src/lib/edit-slice.ts) instead of the whole game.
describe("landmark summaries — the build labels each section (2026-08-28)", () => {
  it("LS.1 the build contract asks for NAME: one-line summary, with both comment styles as examples", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/after\s+a\s+colon/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/PLAYER MOVEMENT:/);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/<!--\s*SCORING:/);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/short,\s*distinct/i); // the pre-existing pin still holds
  });
  it("LS.2 it says WHY — a later edit is shown the summaries and only the sections it needs", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/only\s+the\s+parts?\s+it\s+needs/i);
  });
  it("LS.3 an EDIT keeps the summaries and writes one for any new section it adds", () => {
    const edit = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false, true, false, "default", true);
    expect(edit).toMatch(/keep\s+.*summar/i);
    expect(edit).toMatch(/new\s+section/i);
  });
});

// 2026-08-29: generate levels from a rule instead of hand-typing them. The
// full how-to is a gated playbook (assets/procgen-playbook.ts); these pin the
// two always-present nudges and that the playbook rides the right turns.
describe("procedural generation (2026-08-29)", () => {
  it("PGP.1 the build contract nudges toward a function that BUILDS level N", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/BUILDS level N/);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/instead of typing each one out/i);
  });

  it("PGP.2 an EDIT widens the existing rule rather than pasting level data beside a generator", () => {
    const edit = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false, true, false, "default", true);
    expect(edit).toMatch(/widening that rule/i);
    expect(edit).toMatch(/never by pasting hand-written level data/i);
  });

  it("PGP.3 the playbook rides a gated BUILD turn, and is absent when the gate is closed", () => {
    const on = buildTurnSystemInstruction({ three: false, audio: false, save: false, procgen: true }, false, false, false, "default", false);
    const off = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false, false, false, "default", false);
    expect(on).toContain(PROCGEN_PROMPT_SECTION);
    expect(off).not.toContain(PROCGEN_PROMPT_SECTION);
  });

  it("PGP.4 on an EDIT turn it rides only when the ASK asks for it", () => {
    const gates = { three: false, audio: false, save: false } as const;
    const asked = buildTurnSystemInstruction(gates, false, true, false, "default", false, { procgen: true });
    const plain = buildTurnSystemInstruction(gates, false, true, false, "default", false, {});
    expect(asked).toContain(PROCGEN_PROMPT_SECTION);
    expect(plain).not.toContain(PROCGEN_PROMPT_SECTION);
  });
});

// 2026-08-29 (BUG-FIX-LOG same day, the fairy puzzle): a game shipped that was
// impossible to play. The player's logical position was committed ONLY inside
// the renderer, behind `if (animProgress > 1)` — false when the accumulator
// lands on exactly 1.0 — so the fairy froze after one step. Zero JS errors,
// and three of Ari's own edit turns failed to find it. This rule is always-on
// (NOT in the physics playbook, which only rides 3D turns — the broken game
// was 2D and got no movement guidance at all).
describe("state-commit rule (2026-08-29)", () => {
  it("SC.1 the logical position is committed by the input/step code, never inside the drawing code", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/never\s+inside\s+the\s+drawing\s+code/i);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/real\s+position/i);
  });
  it("SC.2 forbids gating a state change on a strict float comparison, and names the failure", () => {
    expect(CHILD_SYSTEM_PROMPT).toMatch(/>=/);
    expect(CHILD_SYSTEM_PROMPT).toMatch(/freezes?\s+after\s+one\s+step/i);
  });
});

// 2026-08-29 (docs/2026-08-29_PRD_GameFeelAndMotivation.md §4.1–4.3). ALWAYS-ON
// by owner decision: keyword-gating audio left 93% of real games silent, and
// "this game feels like nothing" is just as invisible in a child's words.
describe("game feel — always on (2026-08-29)", () => {
  it("GFW.1 rides a plain BUILD turn with every catalog gate closed", () => {
    const bare = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false, false, false, "default", false);
    expect(bare).toContain(GAME_FEEL_PROMPT_SECTION);
  });

  it("GFW.2 rides an EDIT turn too — a turbo boost added later needs punch as much as a fresh build", () => {
    const edit = buildTurnSystemInstruction({ three: false, audio: false, save: false }, false, true, false, "default", false);
    expect(edit).toContain(GAME_FEEL_PROMPT_SECTION);
  });

  it("GFW.3 the cache prefix stays byte-stable with it in place", () => {
    const gates = { three: true, threeReason: "asked" as const, audio: true, save: true };
    expect(buildTurnSystemInstruction(gates, true, true, false, "default", true))
      .toBe(buildTurnSystemInstruction(gates, true, true, false, "default", true));
  });
});
