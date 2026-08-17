import { describe, it, expect } from "vitest";
import { buildTurnSystemInstruction } from "./gemini";

// A1 + A2 of docs/2026-08-17_PRD_GenerationPipelineRemediation.md, 2026-08-17.
//
// Both faults were read straight out of the owner's own generated game (Mumbai
// Flight Sim), not inferred:
//
// A1 — the keyboard and the on-screen buttons for the SAME action were bound to
// OPPOSITE values:
//     const targetPitch = (keys['ArrowUp'] || keys['KeyW'] || btns.down) ?  0.6
//                       : (keys['ArrowDown']|| keys['KeyS'] || btns.up)  ? -0.6 : 0;
// With `rotation.x = pitch` and forward `(0,0,1)`, positive pitch gives
// `y = -sin(theta)` — i.e. DESCEND. So the DOWN button descended (correct) while
// ArrowUp also descended (inverted). Yaw had the same defect: `ArrowLeft` set
// `roll = +0.8`, rotation.y decreased, the nose swung toward -X — which is
// screen RIGHT when the camera looks along +Z.
//
// This is the owner's "I am not able to move up or down" and "the left right
// and the up down dont work right", reported repeatedly and never fixed,
// because every attempt treated it as a handler bug. It is not: both handlers
// fire perfectly. They just disagree about which way is up.
//
// A2 — `renderer.render(scene, camera)` sat BELOW `if (!gameStarted) return;`
// in the animation loop, so the canvas drew nothing at all until Start was
// pressed. A game that draws nothing is also not obviously distinct from a
// broken one, which muddies the verify probe.
//
// TEST SHAPE — deliberate. The first version of this file asserted bare words
// ("sign", "every frame", "left") against the WHOLE ~15k-token instruction, and
// three of seven assertions passed before the rules existed, matching unrelated
// prose elsewhere in the prompt. A pin that passes without the fix is worse
// than no pin. So each test slices out its OWN rule block by a distinctive lead
// phrase and asserts the substance strictly inside it.

const BUILD_LEAD = "ONE INPUT INTENT, ONE OUTCOME";
const DRAW_LEAD = "DRAW EVERY FRAME";

/** The one contract bullet starting at `lead` — from the lead to the start of
 *  the next top-level bullet. Fails loudly rather than returning "" when the
 *  rule is missing, so an absent rule can never read as a satisfied assertion. */
function rule(contract: string, lead: string): string {
  const start = contract.indexOf(lead);
  expect(start, `the "${lead}" rule is not in this contract at all`).toBeGreaterThan(-1);
  const rest = contract.slice(start);
  const next = rest.search(/\n-\s/);
  return next > 0 ? rest.slice(0, next) : rest;
}

const buildContract = () => buildTurnSystemInstruction();
const editContract = () =>
  buildTurnSystemInstruction({ three: true, audio: true, save: true }, true, /* isEdit */ true);

describe("A1 — one input intent, one outcome", () => {
  it("C.1 the keyboard and the on-screen button for one action write ONE shared value", () => {
    const r = rule(buildContract(), BUILD_LEAD);
    expect(r).toMatch(/keyboard/i);
    expect(r).toMatch(/on-screen button/i);
    // The defect is divergence, so the rule must name the single shared thing
    // and forbid binding the two inputs separately.
    expect(r).toMatch(/same (variable|value|field)|one variable|single variable/i);
  });

  it("C.2 states the direction contract: up moves it up ON SCREEN", () => {
    // Without this the model can bind both inputs consistently and still have
    // them consistently backwards — which is half of what the owner reported.
    const r = rule(buildContract(), BUILD_LEAD);
    expect(r).toMatch(/up on (the )?screen/i);
    expect(r).toMatch(/left/i);
    expect(r).toMatch(/right/i);
  });

  it("C.3 tells the model to WORK THE SIGN OUT rather than assume it", () => {
    // The maths is where it actually went wrong: `rotation.x = +pitch` reads
    // as "nose up" and is the opposite. A rule that says "make up be up"
    // without saying "check the sign" is a wish, not an instruction.
    const r = rule(buildContract(), BUILD_LEAD);
    expect(r).toMatch(/sign/i);
  });

  it("C.4 carries the worked example that produced the bug", () => {
    // A concrete counter-example is what makes this actionable; the abstract
    // version of this rule has effectively been in the prompt (\"controls must
    // work\") for months and did not prevent it.
    const r = rule(buildContract(), BUILD_LEAD);
    expect(r).toMatch(/rotation\.x|pitch/i);
  });

  it("C.5 rides on EDIT turns too — controls are most often re-bound by an edit", () => {
    const r = rule(editContract(), BUILD_LEAD);
    expect(r).toMatch(/same (variable|value|field)|one variable|single variable/i);
    expect(r).toMatch(/up on (the )?screen/i);
  });
});

describe("A2 — the game draws every frame", () => {
  it("C.6 requires the draw call on every frame, including before Start", () => {
    const r = rule(buildContract(), DRAW_LEAD);
    expect(r).toMatch(/renderer\.render/);
    expect(r).toMatch(/start/i);
  });

  it("C.7 gates the SIMULATION on game state, never the draw", () => {
    // The precise shape of the bug: an early `return` above the render call.
    const r = rule(buildContract(), DRAW_LEAD);
    expect(r).toMatch(/return/);
    expect(r).toMatch(/never (gate|skip)|not the draw|below (it|the)/i);
  });

  it("C.8 rides on EDIT turns too", () => {
    const r = rule(editContract(), DRAW_LEAD);
    expect(r).toMatch(/renderer\.render/);
  });
});
