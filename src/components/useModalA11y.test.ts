// The focus-trap wrap-around, tested without a DOM harness.
//
// `nextFocusIndex` is extracted precisely BECAUSE the boundaries are what an
// inline trap gets wrong: wrapping off the last element forward, off the first
// backward, and recovering when focus has escaped the dialog entirely (which
// is the state every one of these overlays was permanently in before the fix —
// role="dialog" declared, focus still on the card behind it).
import { describe, it, expect } from "vitest";
import { nextFocusIndex } from "./useModalA11y";

describe("nextFocusIndex — the boundaries are the trap", () => {
  it("wraps forward off the LAST element to the first", () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
  });

  it("wraps backward off the FIRST element to the last", () => {
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });

  it("lets the browser handle the ordinary middle moves", () => {
    // -1 means "don't preventDefault" — a trap that intercepted every Tab
    // would fight the browser and break things like radio-group arrow order.
    expect(nextFocusIndex(3, 0, false)).toBe(-1);
    expect(nextFocusIndex(3, 1, false)).toBe(-1);
    expect(nextFocusIndex(3, 1, true)).toBe(-1);
    expect(nextFocusIndex(3, 2, true)).toBe(-1);
  });

  it("pulls focus back IN when it has escaped the dialog", () => {
    // current === -1 is "activeElement isn't in the dialog" — the exact state
    // these modals shipped in. Tab must land inside, not continue outside.
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });

  it("a dialog with a single control keeps focus on it", () => {
    expect(nextFocusIndex(1, 0, false)).toBe(0);
    expect(nextFocusIndex(1, 0, true)).toBe(0);
  });

  it("a dialog with nothing focusable defers entirely", () => {
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
    expect(nextFocusIndex(0, 0, true)).toBe(-1);
  });
});
