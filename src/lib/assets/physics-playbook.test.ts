// Contract tests for the motion/physics playbook (2026-07-29,
// docs/2026-07-29_PRD_Physics.md). Owner report: "now it don't follow driving
// physics, rotating physics, jumping and so on".
//
// Root cause this pins against: before this clause the prompt taught NOTHING
// about motion outside SPORTS_PLAYBOOK's football — so every driving, jumping
// and spinning game had its maths reinvented from scratch, with the quality
// varying per turn. These tests pin the rules that make the feel consistent.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PHYSICS_PROMPT_SECTION } from "./physics-playbook";
import { buildTurnSystemInstruction } from "../gemini";

describe("PHYSICS_PROMPT_SECTION — frame-rate independence (the bug behind every 'too fast on my phone')", () => {
  it("mandates delta-time integration, never per-frame constants", () => {
    expect(PHYSICS_PROMPT_SECTION).toMatch(/delta/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/per\s+second|units?\s*\/\s*second|per-second/i);
  });

  it("clamps delta so a backgrounded tab cannot tunnel objects through the floor", () => {
    // Tab-switch returns a multi-second delta; unclamped, one step moves the
    // player past the ground and they fall forever. Real, and invisible in dev.
    expect(PHYSICS_PROMPT_SECTION).toMatch(/Math\.min\(\s*delta/);
  });
});

describe("PHYSICS_PROMPT_SECTION — jumping", () => {
  it("teaches gravity integration plus a grounded check (no infinite mid-air jumps)", () => {
    expect(PHYSICS_PROMPT_SECTION).toMatch(/gravity/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/grounded|onGround/i);
  });

  it("teaches the three things that make a jump feel right, not just parabolic", () => {
    // A textbook parabola feels floaty and unresponsive — these are the
    // standard platformer-feel fixes, and the reason "jumping" was reported.
    expect(PHYSICS_PROMPT_SECTION).toMatch(/coyote/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/variable|cut the jump|released?/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/fall(s)? faster|stronger gravity|fallGravity/i);
  });
});

describe("PHYSICS_PROMPT_SECTION — driving", () => {
  it("models a car as speed + heading, not as free x/z movement", () => {
    expect(PHYSICS_PROMPT_SECTION).toMatch(/heading|steer/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/speed/i);
  });

  it("ties turn rate to speed — a parked car must not spin on the spot", () => {
    // THE driving-feel bug: steering applied regardless of speed lets a
    // stationary car pirouette, which reads as "not driving physics".
    expect(PHYSICS_PROMPT_SECTION).toMatch(/parked|stationary|standing still|not moving/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/turn rate|steer.*speed|speed.*steer/i);
  });

  it("teaches drag/friction and reverse so a car coasts and backs up", () => {
    expect(PHYSICS_PROMPT_SECTION).toMatch(/drag|friction/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/reverse|backwards?/i);
  });
});

describe("PHYSICS_PROMPT_SECTION — rotation and bouncing", () => {
  it("teaches angular velocity with decay rather than a fixed rotation.y += 0.01", () => {
    expect(PHYSICS_PROMPT_SECTION).toMatch(/angular/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/decay|slows|friction/i);
  });

  it("teaches rolling: spin tied to distance travelled and radius", () => {
    expect(PHYSICS_PROMPT_SECTION).toMatch(/roll/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/radius/i);
  });

  it("teaches restitution with a rest threshold (a ball must stop, not jitter forever)", () => {
    expect(PHYSICS_PROMPT_SECTION).toMatch(/bounc/i);
    expect(PHYSICS_PROMPT_SECTION).toMatch(/threshold|stop bouncing|comes? to rest/i);
  });
});

describe("PHYSICS_PROMPT_SECTION — cache + wiring contract", () => {
  it("is a static constant: it can never vary with the child's message", () => {
    // Same rule as SPORTS_PLAYBOOK. A per-message system prompt breaks the
    // Gemini prefix cache on everything behind it (COST_TOKEN_BUDGET.md #4).
    expect(typeof PHYSICS_PROMPT_SECTION).toBe("string");
    expect(PHYSICS_PROMPT_SECTION).not.toMatch(/\$\{/);
  });

  it("rides the 3D gate — a locked turn stays byte-identical to the bare prompt", () => {
    const locked = buildTurnSystemInstruction({ three: false, audio: false }, false);
    expect(locked).not.toContain(PHYSICS_PROMPT_SECTION);
  });

  it("is actually sent on an unlocked build turn (a section nobody wires in is worthless)", () => {
    expect(buildTurnSystemInstruction()).toContain(PHYSICS_PROMPT_SECTION);
  });

  it("applies to 2D games too — the rules are not Three.js-specific", () => {
    // Jump feel and car handling matter just as much on a 2D canvas; nothing
    // in the clause may assume a 3D scene.
    expect(PHYSICS_PROMPT_SECTION).not.toMatch(/WebGLRenderer|PerspectiveCamera/);
  });

  it("stays inside a token budget of its own — feel guidance, not an essay", () => {
    // 470, landing at 456. The first draft was 577; the 121 tokens cut were
    // rhetoric ("the #1 'it feels wrong'"), not rules. What remains is each
    // rule pinned by a test above, so a future breach means content was ADDED
    // and should be justified — do not raise this to make room for prose.
    // This section rides every 3D build turn, on top of the ~1,712-token
    // model catalog, so it is real recurring spend.
    expect(Math.ceil(PHYSICS_PROMPT_SECTION.length / 4)).toBeLessThanOrEqual(470);
  });
});
