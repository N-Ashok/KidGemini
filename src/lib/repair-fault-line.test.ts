import { describe, it, expect } from "vitest";
import { repairFaultLine } from "./repair-prompt";

// BUG_LOG 2026-08-17. The strict-retry rung does 100% of the repair work in
// production (the first attempt returned no_patch_in_reply on 4 of 4 observed
// repairs), and it was building its prompt as:
//
//   String(errors[0])                    -> "[object Object]"   (errors are objects)
//   ...or, when errors is empty:
//   `the game fails with: ${failureCode}` -> "the game fails with: start_occluded"
//
// So the model actually fixing the game was told "Fix this error and change
// nothing else: [object Object]" — while REPAIR_TAXONOMY already held a precise
// instruction naming the offending element and the exact remedy. Every observed
// start_occluded repair came back a no-op (+10, +12, -12 chars) and the probe
// re-failed on the repair's own output.
describe("repairFaultLine — the strict retry must get the REAL diagnosis", () => {
  it("F.1 names the occluding element and the fix, not the bare failure code", () => {
    const line = repairFaultLine({
      failureCode: "start_occluded",
      evidence: { start: { x: 100, y: 200, occluded: true, occluder: "div.controls-layer" } } as never,
      errors: [],
    });
    expect(line).toContain("div.controls-layer");
    expect(line).toContain("100");
    expect(line).toContain("pointer-events");
    expect(line).not.toBe("the game fails with: start_occluded");
  });

  it("F.2 never yields [object Object] for an error-carrying failure", () => {
    const line = repairFaultLine({
      failureCode: "load_error",
      evidence: null,
      errors: [{ level: "error", kind: "error", text: "THREE.Foo is not a constructor" } as never],
    });
    expect(line).not.toContain("[object Object]");
    expect(line.length).toBeGreaterThan(20);
  });

  it("F.3 still returns usable guidance when evidence is missing", () => {
    const line = repairFaultLine({ failureCode: "start_occluded", evidence: null, errors: [] });
    expect(line).toContain("pointer-events");
    expect(line).not.toContain("[object Object]");
  });
});
