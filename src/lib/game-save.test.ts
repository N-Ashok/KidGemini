// Validation for client-submitted save states (docs/2026-08-01_PRD_SaveContinueBuilding.md
// §3e). Fail-closed: anything malformed returns null and the write is rejected.

import { describe, it, expect } from "vitest";
import { sanitizeGameSaveState } from "./game-save";
import { MAX_STATE_JSON_BYTES } from "./game-save.config";

const validState = {
  areas: [
    { id: "city-1", originX: 100, originZ: 200, objects: [{ type: "block", x: 12, y: 0, z: 4, rotation: 0 }] },
    { id: "city-2", originX: 5000, originZ: 8000, objects: [] },
  ],
};

describe("sanitizeGameSaveState", () => {
  it("accepts a well-formed multi-area state, preserving every area and object field", () => {
    const result = sanitizeGameSaveState(validState);
    expect(result).toEqual(validState);
  });

  it("accepts a single empty area (a game with nothing built yet)", () => {
    expect(sanitizeGameSaveState({ areas: [{ id: "a", originX: 0, originZ: 0, objects: [] }] })).toEqual({
      areas: [{ id: "a", originX: 0, originZ: 0, objects: [] }],
    });
  });

  it("rejects a payload missing areas entirely", () => {
    expect(sanitizeGameSaveState({})).toBeNull();
    expect(sanitizeGameSaveState(null)).toBeNull();
    expect(sanitizeGameSaveState(undefined)).toBeNull();
    expect(sanitizeGameSaveState("not an object")).toBeNull();
  });

  it("rejects areas that isn't an array", () => {
    expect(sanitizeGameSaveState({ areas: "nope" })).toBeNull();
    expect(sanitizeGameSaveState({ areas: {} })).toBeNull();
  });

  it("rejects an area missing an id or numeric origin", () => {
    expect(sanitizeGameSaveState({ areas: [{ originX: 0, originZ: 0, objects: [] }] })).toBeNull();
    expect(sanitizeGameSaveState({ areas: [{ id: "a", originX: "0", originZ: 0, objects: [] }] })).toBeNull();
    expect(sanitizeGameSaveState({ areas: [{ id: "a", originX: 0, originZ: "0", objects: [] }] })).toBeNull();
  });

  it("rejects an area whose objects isn't an array", () => {
    expect(sanitizeGameSaveState({ areas: [{ id: "a", originX: 0, originZ: 0, objects: "nope" }] })).toBeNull();
  });

  it("rejects a non-object entry inside objects", () => {
    expect(
      sanitizeGameSaveState({ areas: [{ id: "a", originX: 0, originZ: 0, objects: [null] }] }),
    ).toBeNull();
    expect(
      sanitizeGameSaveState({ areas: [{ id: "a", originX: 0, originZ: 0, objects: ["nope"] }] }),
    ).toBeNull();
  });

  it("rejects a state that serializes over the size cap", () => {
    // One area with enough objects to blow past MAX_STATE_JSON_BYTES.
    const objects = Array.from({ length: 30_000 }, (_, i) => ({ type: "block", x: i, y: 0, z: i, rotation: 0 }));
    const huge = { areas: [{ id: "big", originX: 0, originZ: 0, objects }] };
    expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_STATE_JSON_BYTES);
    expect(sanitizeGameSaveState(huge)).toBeNull();
  });

  it("accepts a state right at the size cap boundary", () => {
    // Pad a single object's field until the serialized state sits just under the cap.
    const padding = "x".repeat(MAX_STATE_JSON_BYTES - 200);
    const atLimit = { areas: [{ id: "a", originX: 0, originZ: 0, objects: [{ note: padding }] }] };
    expect(JSON.stringify(atLimit).length).toBeLessThanOrEqual(MAX_STATE_JSON_BYTES);
    expect(sanitizeGameSaveState(atLimit)).not.toBeNull();
  });
});
