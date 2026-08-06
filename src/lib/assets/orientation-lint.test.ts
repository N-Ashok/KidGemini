// Library facing convention (BUG-FIX-LOG 2026-08-06, "the sideways black
// bike"): every VEHICLE model faces +Z at rest, so one shared `rotation.y`
// rule steers the whole library. street_motorcycle shipped authored 90° off
// (nose at +X) — an asset defect no amount of game-code iteration can fix,
// because a model's rest orientation is invisible to the LLM. These pin the
// vendor pipeline's orientation math + lint (scripts/lib/orientation.mjs):
// the lint makes a sideways vehicle FAIL curation, and the bake helpers are
// what rotateYDeg uses to fix one.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs script module, no type declarations by design
import { longHorizontalAxis, assertLongAxisZ, yRotation } from "../../../scripts/lib/orientation.mjs";

describe("orientation lint — vehicles must be Z-long (face +Z)", () => {
  it("identifies the long horizontal axis from bounds (Y never counts — height is not facing)", () => {
    expect(longHorizontalAxis({ min: [-1.1, 0, -0.4], max: [1.1, 2, 0.4] })).toBe("x"); // the street_motorcycle shape
    expect(longHorizontalAxis({ min: [-0.3, 0, -0.95], max: [0.3, 5, 0.95] })).toBe("z"); // tall but Z-long
  });

  it("assertLongAxisZ throws a fix-it message on an X-long vehicle, passes a Z-long one", () => {
    expect(() => assertLongAxisZ("street_motorcycle", { min: [-1.1, 0, -0.4], max: [1.1, 1.4, 0.4] })).toThrow(
      /rotateYDeg/,
    );
    expect(() => assertLongAxisZ("motorcycle", { min: [-0.2, 0, -0.95], max: [0.2, 0.9, 0.95] })).not.toThrow();
  });

  it("yRotation(-90) maps a +X nose to +Z (quaternion + translation, gltf-transform order)", () => {
    const { quat, rotateVec } = yRotation(-90);
    // Quaternion for -90° about Y: [0, -sin45, 0, cos45].
    expect(quat[0]).toBeCloseTo(0);
    expect(quat[1]).toBeCloseTo(-Math.SQRT1_2);
    expect(quat[2]).toBeCloseTo(0);
    expect(quat[3]).toBeCloseTo(Math.SQRT1_2);
    // The nose point (1, 0, 0) lands on (0, 0, 1) — facing +Z.
    const [x, y, z] = rotateVec([1, 0, 0]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it("composing yRotation with an existing node rotation keeps the node's own spin (multiply order: bake ∘ node)", () => {
    const { composeQuat } = yRotation(-90);
    const identity = [0, 0, 0, 1];
    const composed = composeQuat(identity);
    expect(composed[1]).toBeCloseTo(-Math.SQRT1_2);
    expect(composed[3]).toBeCloseTo(Math.SQRT1_2);
  });
});
