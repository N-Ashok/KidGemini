// Pins that the two copies of the fitness rules agree — src/lib/assets/fitness.ts
// (tests, app) and scripts/lib/fitness.mjs (the vendor pipeline, which is plain
// .mjs and cannot import TS).
//
// This test is the reason the duplication is acceptable. The repo has already
// been bitten once by exactly this: the vendor pipeline wrote a manifest field
// as `p.pathAxis` while the validator read `p.model.pathAxis`, and only the
// pipeline's own late-stage gate caught it. Two copies of a rule set with no
// parity check is the same bug waiting to happen — and it would fail OPEN, with
// the blocking gate quietly disagreeing with the sweep everyone reads.

import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";
import type { AssetEntry } from "./manifest";
import { assessLibrary } from "./fitness";
// @ts-expect-error — plain .mjs sibling, deliberately untyped (see header)
import { assessLibrary as assessLibraryMjs } from "../../../scripts/lib/fitness.mjs";

const models = (manifest.assets as AssetEntry[]).filter((a) => a.type === "model");

describe("fitness.ts and scripts/lib/fitness.mjs stay in lock-step", () => {
  it("returns identical verdicts AND identical reason text for the whole library", () => {
    // Reason text, not just the verdict: the wording IS the actionable part of
    // a finding, and a gate that refuses with a different explanation than the
    // sweep gave is its own kind of broken.
    expect(JSON.stringify(assessLibraryMjs(models), null, 2)).toBe(
      JSON.stringify(assessLibrary(models), null, 2),
    );
  });

  it("agrees on a synthetic failure too, not just on the committed happy path", () => {
    // The committed library is mostly clean, so parity on it alone would pass
    // even if both copies had stopped detecting anything.
    const rogue = { ...models.find((m) => m.name === "race_track_straight")!, name: "race_track_bad", lane: 0.4 };
    const set = [...models, rogue];
    expect(JSON.stringify(assessLibraryMjs(set))).toBe(JSON.stringify(assessLibrary(set)));
    expect(assessLibrary(set).find((f) => f.name === "race_track_bad")?.verdict).toBe("fail");
  });
});
