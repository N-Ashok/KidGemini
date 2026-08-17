import { describe, it, expect } from "vitest";
import { buildTurnSystemInstruction } from "./gemini";

// BUG_LOG / KNOWN_BUGS #22, 2026-08-17.
//
// Commit 9452e2c (2026-08-14/15) added "Show a START SCREEN before play begins"
// and "Build the HUD (score, health/status bars, on-screen buttons, messages)"
// to the build contract. Both instruct the model to put full-screen layers ON
// TOP of the game — and nothing in ANY prompt mentioned `pointer-events`.
//
// Production, measured: `start_occluded` had NEVER occurred in the two weeks
// before Aug 15 (every repair was load_error). It appeared for the first time
// on Aug 15 and hit 4-of-4 generations in one owner session, every one with
// `err=none` — no crash, correct click handlers, taps simply not arriving.
// That is the owner's "the take off and land buttons are not working", which
// survived four fixes aimed at the button LOGIC because the logic was never
// the bug.
//
// Prevention beats the self-heal here: the repair for this class was measured
// 0-for-3 (no-op patches of ~10 chars, with the probe re-failing on the
// repair's own output).
describe("build contract — overlays must not swallow taps", () => {
  const contract = buildTurnSystemInstruction();

  it("P.1 teaches pointer-events at all (it taught nothing before this fix)", () => {
    expect(contract).toMatch(/pointer-events/i);
  });

  it("P.2 gives BOTH escapes — remove/hide it, or make it inert", () => {
    expect(contract).toMatch(/display\s*:\s*none/i);
    expect(contract).toMatch(/pointer-events:\s*none/i);
    expect(contract).toMatch(/pointer-events:\s*auto/i);
  });

  it("P.3 names the trap: it looks fine and logs nothing", () => {
    // The rule has to say WHY this is invisible, or it reads as style advice.
    expect(contract).toMatch(/never arrive|taps|click handlers/i);
  });

  it("P.4 covers the opacity-0-but-still-there case", () => {
    expect(contract).toMatch(/opacity/i);
  });

  it("P.5 rides on EDIT turns too — every occlusion came from an edit", () => {
    const editContract = buildTurnSystemInstruction(
      { three: true, audio: true, save: true },
      true,
      /* isEdit */ true,
    );
    // The build contract is part of the edit persona base, so the rule must
    // survive there: 4 of 4 occlusions in the owner session were introduced by
    // an EDIT, not by the first build.
    expect(editContract).toMatch(/pointer-events/i);
  });
});
