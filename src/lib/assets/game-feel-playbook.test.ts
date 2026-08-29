// The game-feel playbook (docs/2026-08-29_PRD_GameFeelAndMotivation.md §4.1–4.3,
// built 2026-08-29). Owner's trigger: a turbo boost that changed a speed
// variable with no shake, no particles and no sound — "for a turbo boost, it
// was pathetic."
import { describe, it, expect } from "vitest";
import { GAME_FEEL_PROMPT_SECTION } from "./game-feel-playbook";

describe("GAME_FEEL_PROMPT_SECTION", () => {
  it("GF.1 teaches hit-stop with a real frame count — the cheapest impact trick", () => {
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/freeze[\s\S]{0,60}(3|three)[\s\S]{0,20}(5|five)?\s*frames?|hit-?stop/i);
  });

  it("GF.2 teaches screen shake SCALED to the event, not a constant", () => {
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/shake/i);
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/big(ger)? (the )?(event|hit|crash)|scale|small.*small|bigger.*bigger/i);
  });

  it("GF.3 teaches particles on pickup/hit and tweened transitions", () => {
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/particle|sparkle|burst/i);
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/slide|fade|tween|ease/i);
  });

  // The calibration clause. Research: medium and high juiciness outperform BOTH
  // none AND extreme, on player experience, motivation, play time and score.
  // A prompt that just says "add lots of juice" aims at the losing band.
  it("GF.4 carries the DON'T-OVERDO-IT clause — extreme juice measurably under-performs", () => {
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/not so much|never so much|too much|overdo/i);
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/see|read|follow|find/i);
  });

  // Evidenced for exactly this age band: a task-IRRELEVANT choice (pick your
  // spaceship) raised intrinsic motivation and learning.
  it("GF.5 asks for a cosmetic choice at the start that does NOT change the game", () => {
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/choose|pick/i);
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/colour|color|hat|character|skin/i);
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/only\s+how\s+(the\s+game|it)\s+looks|never\s+how\s+it\s+plays/i);
  });

  // Evidenced: feedback must indicate DISTANCE TO THE GOAL, not just score.
  it("GF.6 asks for live progress toward the goal, not merely a score", () => {
    expect(GAME_FEEL_PROMPT_SECTION).toMatch(/how far|progress|\d+ ?\/ ?\d+|left to/i);
  });

  it("GF.7 is a constant with no interpolation (cache prefix contract)", () => {
    expect(GAME_FEEL_PROMPT_SECTION).not.toMatch(/\$\{/);
  });

  it("GF.8 stays inside its token ceiling — it rides EVERY build", () => {
    // Always-on by owner decision 2026-08-29: keyword-gating left 93% of games
    // silent on audio, and "feels like nothing" is just as invisible in a
    // child's words. ~1% of a build. At 420, cut content — do not raise this.
    expect(Math.ceil(GAME_FEEL_PROMPT_SECTION.length / 4)).toBeLessThanOrEqual(420);
  });
});
