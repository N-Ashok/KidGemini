// The procedural-generation playbook (2026-08-29, owner ask after reading how
// Minecraft / No Man's Sky / Dead Cells / Spelunky generate content).
// Pins the rules that make a GENERATED level safe for a 7-year-old — the
// failure modes are unsolvable levels, difficulty spikes and a frozen tab, and
// none of those can be caught by a string assertion on the game afterwards.
import { describe, it, expect } from "vitest";
import { PROCGEN_PROMPT_SECTION } from "./procgen-playbook";

describe("PROCGEN_PROMPT_SECTION", () => {
  it("PG.1 teaches difficulty as a FORMULA of the level index, clamped", () => {
    expect(PROCGEN_PROMPT_SECTION).toMatch(/level \* 0\.6|level \* 5|level \* 0\.08/);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/Math\.max|Math\.min/);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/clamp/i);
  });

  // The load-bearing string: if the model garbles this, every generated layout
  // is wrong AND unreproducible. Pinned character-exact.
  it("PG.2 ships a correct seeded PRNG verbatim, and forbids bare Math.random() for layout", () => {
    expect(PROCGEN_PROMPT_SECTION).toContain("0x6D2B79F5");
    expect(PROCGEN_PROMPT_SECTION).toContain("Math.imul");
    expect(PROCGEN_PROMPT_SECTION).toContain("4294967296");
    expect(PROCGEN_PROMPT_SECTION).toMatch(/never use bare `Math\.random\(\)` for layout/i);
  });

  it("PG.2b the seeded PRNG in the prompt actually works — same seed, same sequence, spread over 0..1", () => {
    // Extract the function the prompt hands the model and run it. A typo here
    // ships broken layouts to every child, so the prompt's own code is tested.
    const src = /function rng\(s\)\{[^\n]*\}/.exec(PROCGEN_PROMPT_SECTION)?.[0];
    expect(src, "rng one-liner not found in the playbook").toBeTruthy();
    const rng = new Function(`${src}; return rng;`)() as (s: number) => () => number;
    const a = rng(42), b = rng(42), c = rng(43);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);                       // same seed → same level
    expect(seqA).not.toEqual([c(), c(), c(), c(), c()]); // different seed → different level
    for (const v of seqA) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    expect(new Set(seqA).size).toBe(5);               // not a constant
  });

  it("PG.3 carves the guaranteed path FIRST and decorates after (Spelunky's solvable-by-construction rule)", () => {
    expect(PROCGEN_PROMPT_SECTION).toMatch(/route from the start to the goal\s+FIRST|path first/i);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/only\s+THEN scatter/i);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/cannot be unwinnable|never have to test it/i);
  });

  it("PG.4 assembles hand-made PIECES rather than randomising every tile (the sameness/noise failure)", () => {
    expect(PROCGEN_PROMPT_SECTION).toMatch(/four to six|hand-made chunks/i);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/every single tile/i);
  });

  it("PG.5 caps retry loops — an uncapped generator freezes the page", () => {
    expect(PROCGEN_PROMPT_SECTION).toMatch(/tries < 50|cap it/i);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/freezes/i);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/known-good|fall back/i);
  });

  it("PG.6 restates the winnability floor INSIDE the generator (3s grace, safe spawn, escape, jumpable gaps)", () => {
    expect(PROCGEN_PROMPT_SECTION).toMatch(/first\s+3\s+seconds/i);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/spawns\s+clear\s+of\s+every\s+hazard/i);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/escape\s+move/i);
    expect(PROCGEN_PROMPT_SECTION).toMatch(/jump/i);
  });

  // Cache contract, same as PHYSICS_PROMPT_SECTION / SPORTS_PLAYBOOK: a plain
  // constant with no interpolation, so the system prompt stays byte-identical
  // per turn and Gemini prefix caching keeps hitting.
  it("PG.7 is a constant — byte-identical on every read, no per-child interpolation", () => {
    expect(PROCGEN_PROMPT_SECTION).toBe(PROCGEN_PROMPT_SECTION);
    expect(PROCGEN_PROMPT_SECTION).not.toMatch(/\$\{/);
  });

  it("PG.8 stays inside its token ceiling (§8 scale ceiling — revisit past ~600 tokens)", () => {
    // ~4 chars/token. It rides only gated turns, but `levels?` fires often, so
    // the ceiling is what keeps that affordable.
    expect(Math.ceil(PROCGEN_PROMPT_SECTION.length / 4)).toBeLessThanOrEqual(600);
  });
});
