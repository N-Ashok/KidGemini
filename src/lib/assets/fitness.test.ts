// Test-first for the asset-fitness rules (docs/2026-08-08_PRD_AssetFitnessAndReview.md
// Layer 1). Written BEFORE fitness.ts, against the REAL committed manifest —
// these rules exist to catch faults that reached children, so the fixtures are
// the actual pieces that did or did not tile, not invented ones.
//
// The measurements come from scripts/render-assets.mjs (2026-08-09): a
// top-down render of the published bytes, sampling the carriageway where it
// meets each edge. That instrument exists because the geometry CANNOT answer
// this — these are flat single-material slabs with the road painted into the
// colormap, so two earlier geometric probes both returned "(none)".

import { describe, expect, it } from "vitest";
import manifest from "./manifest.json";
import type { AssetEntry } from "./manifest";
import { assessLibrary, assessModel, type FitnessFinding } from "./fitness";

const models = (manifest.assets as AssetEntry[]).filter((a) => a.type === "model");
const by = (name: string) => {
  const e = models.find((m) => m.name === name);
  if (!e) throw new Error(`fixture "${name}" is missing from the manifest`);
  return e;
};
const verdictOf = (findings: FitnessFinding[], name: string) =>
  findings.find((f) => f.name === name)?.verdict;

describe("assessModel — path pieces only", () => {
  it("ignores a model that is not a path piece (no pathAxis declared)", () => {
    // `car` is an actor, not a tile. Holding it to a module contract would
    // flood the worklist with noise and get the whole gate ignored.
    expect(assessModel(by("car"), models).verdict).toBe("not-a-path-piece");
  });

  it("passes the racing straight — 1 m module, 0.70 m carriageway, runs Z", () => {
    expect(assessModel(by("race_track_straight"), models).verdict).toBe("pass");
  });

  it("passes race_track_corner — it MATES the straight (same 1 m module, same 0.70 m lane)", () => {
    // This is the piece vendored to fix the 2026-08-08 track. If this ever
    // regresses, the corner stops meeting the straight and the track reopens.
    const f = assessModel(by("race_track_corner"), models);
    expect(f.verdict).toBe("pass");
    expect(f.lane).toBeCloseTo(0.7, 2);
  });

  it("passes finish_line — a PROP, so its 1.26 m overhang is not a module failure", () => {
    // The 2026-08-08 game scaled this x10 while scaling straights x20, giving
    // a 7 m gantry over a 20 m road. The ASSET was always right; the fault was
    // that nothing published the lane width for the model to match against.
    // Its 1.26 m width is verge hanging over the grass — held to the
    // carriageway rule only, which it matches exactly.
    const f = assessModel(by("finish_line"), models);
    expect(f.verdict).toBe("pass");
    expect(f.lane).toBeCloseTo(0.7, 2);
  });

  it("fails a road prop held to the tile grid — the rule that made pathRole necessary", () => {
    // Pins the distinction rather than just its effect: the SAME asset, marked
    // as a tile, is an outright module failure. Without pathRole the gate
    // condemns a correct piece, which is how a gate teaches people to ignore it.
    const asTile = { ...by("finish_line"), pathRole: "tile" as const };
    expect(assessModel(asTile, models).verdict).toBe("fail");
  });
});

describe("assessModel — the faults that actually shipped", () => {
  it("FAILS race_track_curve: 1.5 m is not a multiple of its kit's 1 m module", () => {
    // The headline fault. 1.5 is not a multiple of 1, so no rotation or scale
    // a child or the model can write makes it meet a straight — which is why
    // re-prompting was an unwinnable loop.
    const f = assessModel(by("race_track_curve"), models);
    expect(f.verdict).toBe("fail");
    expect(f.reasons.join(" ")).toMatch(/module/i);
  });

  it("flags race_track_curve as a CHICANE, not a corner — its joins are opposite edges", () => {
    // The name lies (TECH_DEBT #96). Its measured joins are -z and +z: it
    // enters north and leaves south with a lateral shift. A model told to
    // "use the curve to turn" can only produce a broken track.
    const f = assessModel(by("race_track_curve"), models);
    expect(f.joins).toEqual(["-z", "+z"]);
    expect(f.reasons.join(" ")).toMatch(/chicane|opposite/i);
  });

  it("catches the chicane's off-grid EXIT — the rule that needs join offsets", () => {
    // The sharpest statement of the bug. race_track_curve and road_curve have
    // the same shape of `joins` and near-identical `lane`; only the offsets
    // separate them. The chicane leaves at 1.00 m on a 1 m grid, which is a
    // cell BOUNDARY — nothing on-grid can follow it, at any scale.
    expect(assessModel(by("race_track_curve"), models).reasons.join(" ")).toMatch(/boundary/i);
    expect(assessModel(by("road_curve"), models).reasons.join(" ")).not.toMatch(/boundary/i);
  });
});

describe("assessModel — pathAxis must agree with the measured joins", () => {
  it("passes road_straight: joins -x/+x and declares pathAxis x", () => {
    expect(assessModel(by("road_straight"), models).verdict).toBe("pass");
  });

  it("passes road_curve: a corner (joins -x and +z) correctly declares pathAxis none", () => {
    // 2 x 2 m with an 0.81 m lane matching road_straight — a VALID piece, just
    // a two-cell sweeping turn rather than a one-cell corner. The gate must not
    // cry wolf on it or the real failures get lost.
    expect(assessModel(by("road_curve"), models).verdict).toBe("pass");
  });

  it("passes road_intersection: three joins correctly declare pathAxis none", () => {
    expect(assessModel(by("road_intersection"), models).verdict).toBe("pass");
  });

  it("needs eyes on road_ramp, and ships NO join data for it", () => {
    // A true limit of the instrument, surfaced rather than guessed at: from
    // directly above, a ramp's sloped side skirts are the same grey as its
    // tarmac, so the probe reads all four edges and a 1.00 m lane — both
    // wrong. TECH_DEBT #93's rule applies: a confidently-wrong value is worse
    // than an admitted gap, so the measurement is deliberately NOT recorded and
    // the piece sits on the worklist until a human settles it.
    const f = assessModel(by("road_ramp"), models);
    expect(f.verdict).toBe("needs-eyes");
    expect(f.reasons.join(" ")).toMatch(/never been measured/i);
    expect(by("road_ramp").joins).toBeUndefined();
  });
});

describe("assessModel — kits must be internally consistent", () => {
  it("fails a piece whose carriageway does not match its kit", () => {
    // Synthetic: the fault class that makes a piece look right in a table and
    // wrong on screen. A 0.40 m lane cannot mate a 0.70 m racing straight.
    const rogue: AssetEntry = { ...by("race_track_straight"), name: "race_track_narrow", lane: 0.4 };
    const f = assessModel(rogue, [...models, rogue]);
    expect(f.verdict).toBe("fail");
    expect(f.reasons.join(" ")).toMatch(/carriageway|lane/i);
  });

  it("needs eyes on a path piece that has never been measured", () => {
    // Absent is not the same as fine. Anything unmeasured goes on the worklist.
    const unmeasured: AssetEntry = { ...by("race_track_straight"), name: "road_mystery" };
    delete (unmeasured as Partial<AssetEntry>).joins;
    delete (unmeasured as Partial<AssetEntry>).lane;
    const f = assessModel(unmeasured, [...models, unmeasured]);
    expect(f.verdict).toBe("needs-eyes");
    expect(f.reasons.join(" ")).toMatch(/measured|render/i);
  });
});

describe("assessLibrary — the standing sweep", () => {
  const findings = assessLibrary(models);

  it("reports only path pieces — actors and scenery never reach the worklist", () => {
    expect(findings.every((f) => f.verdict !== "not-a-path-piece")).toBe(true);
    expect(findings.some((f) => f.name === "car")).toBe(false);
  });

  it("clears every city road piece except the ramp the probe cannot read", () => {
    for (const name of ["road_straight", "road_crossing", "road_intersection", "road_roundabout", "road_curve"]) {
      expect(verdictOf(findings, name), name).toBe("pass");
    }
  });

  it("clears road_bridge now that its axis is declared z", () => {
    // Long undeclared (TECH_DEBT #93) because two geometric probes disagreed.
    // The render settled it: its carriageway runs north-south, opposite every
    // other city piece. A game mixing it with road_straight laid it crosswise.
    expect(by("road_bridge").pathAxis).toBe("z");
    expect(verdictOf(findings, "road_bridge")).toBe("pass");
  });

  it("names the racing chicane as the one outright failure in the library", () => {
    expect(findings.filter((f) => f.verdict === "fail").map((f) => f.name)).toEqual(["race_track_curve"]);
  });
});
