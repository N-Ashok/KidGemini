// Asset fitness — does a piece work in the thing a child actually builds?
// (docs/2026-08-08_PRD_AssetFitnessAndReview.md, Layer 1.)
//
// The vendor pipeline already validates magic bytes, byte budget, licence
// proof, post-upload sha256, vehicle long-axis and origin centring. All real,
// and none of them caught a single one of the three asset faults that reached
// children in the week of 2026-08-08. The pattern: we check the numbers we
// thought of, and nobody ever looks at the asset.
//
// These rules ask the one question the others do not — can this tile TILE? —
// using measurements taken from a top-down render of the PUBLISHED bytes
// (scripts/render-assets.mjs), because the geometry cannot answer it.
//
// Pure: no I/O, no browser, no model call. Runs in milliseconds, which is what
// lets it be a blocking gate that survives contact with a routine batch. The
// mirrored pipeline copy is scripts/lib/fitness.mjs (same split as
// orientation.mjs <-> orientation-lint.test.ts).

import type { AssetEntry } from "./manifest";

export type TileEdge = "-x" | "+x" | "-z" | "+z";

/** `pass` ships. `fail` is arithmetically broken — it cannot mate at any scale
 *  or rotation. `needs-eyes` is an ADMITTED GAP: something the instrument
 *  cannot read, which a human must settle. Never conflate the last two — the
 *  whole discipline (TECH_DEBT #93) is that a confidently-wrong value is worse
 *  than a missing one. */
export type Verdict = "pass" | "fail" | "needs-eyes" | "not-a-path-piece";

export interface FitnessFinding {
  name: string;
  verdict: Verdict;
  /** Human-readable, one per rule broken. Empty on a clean pass. */
  reasons: string[];
  kit?: string;
  joins?: TileEdge[];
  lane?: number;
  size?: [number, number, number];
  /** The kit's base module in metres, if it could be established. */
  module?: number;
}

/** A tile edge is off-module if it misses a whole multiple by more than this.
 *  Generous: vendored geometry carries meshopt quantisation error, and we are
 *  separating 1.5 from 1.0, not 1.001 from 1.0. */
const MODULE_TOLERANCE_M = 0.03;
/** Two carriageways this close mate visibly cleanly at kid-game scale — the
 *  city kit's own straight (0.81 m) and bridge (0.84 m) sit inside it. */
const LANE_TOLERANCE_M = 0.05;

/** A model is a PATH piece iff the curator declared a `pathAxis` for it —
 *  including `'none'`. That declaration IS the statement of intent, so no
 *  second `pathRole` field is introduced for a human to forget to maintain. */
export function isPathPiece(e: AssetEntry): boolean {
  return e.type === "model" && e.pathAxis !== undefined;
}

/** The smallest footprint edge among a kit's measured path pieces. Every other
 *  piece in the kit must be a whole multiple of it. */
export function kitModule(kit: string | undefined, all: AssetEntry[]): number | undefined {
  const sizes = all
    .filter((a) => isPathPiece(a) && a.kit === kit && a.size)
    .flatMap((a) => [a.size![0], a.size![2]]);
  return sizes.length ? Math.min(...sizes) : undefined;
}

/** The carriageway width the kit agrees on — the MEDIAN, not the mean, so one
 *  rogue piece cannot drag the reference toward itself and exonerate itself. */
export function kitLane(kit: string | undefined, all: AssetEntry[]): number | undefined {
  const lanes = all
    .filter((a) => isPathPiece(a) && a.kit === kit && typeof a.lane === "number")
    .map((a) => a.lane!)
    .sort((x, y) => x - y);
  return lanes.length ? lanes[Math.floor(lanes.length / 2)] : undefined;
}

const isMultiple = (value: number, base: number) =>
  Math.abs(value / base - Math.round(value / base)) * base <= MODULE_TOLERANCE_M;

/** What the measured joins imply the `pathAxis` declaration should be. */
function impliedAxis(joins: TileEdge[]): "x" | "z" | "none" {
  const set = new Set(joins);
  if (set.size === 2 && set.has("-x") && set.has("+x")) return "x";
  if (set.size === 2 && set.has("-z") && set.has("+z")) return "z";
  return "none";
}

export function assessModel(e: AssetEntry, all: AssetEntry[]): FitnessFinding {
  if (!isPathPiece(e)) return { name: e.name, verdict: "not-a-path-piece", reasons: [] };

  const reasons: string[] = [];
  let verdict: Verdict = "pass";
  const fail = (why: string) => {
    reasons.push(why);
    verdict = "fail";
  };
  const eyes = (why: string) => {
    reasons.push(why);
    if (verdict !== "fail") verdict = "needs-eyes";
  };

  const module = kitModule(e.kit, all);
  const lane = kitLane(e.kit, all);
  const base: FitnessFinding = {
    name: e.name,
    verdict,
    reasons,
    kit: e.kit,
    joins: e.joins,
    lane: e.lane,
    size: e.size,
    module,
  };

  if (!e.size) {
    eyes("no measured size — skinned models cannot be measured from bind-pose bytes (TECH_DEBT #93)");
    return { ...base, verdict };
  }

  // --- Joins: has anyone ever actually looked? --------------------------
  // Done FIRST because everything numeric below depends on trusting the probe,
  // and the probe announces its own unreliability through a disagreement with
  // the curator's `pathAxis` declaration.
  let trusted = false;
  if (!e.joins || e.joins.length === 0) {
    eyes(
      "carriageway edges have never been measured — run scripts/render-assets.mjs and " +
        "scripts/backfill-tile-edges.mjs; without this a model can only guess a corner's rotation",
    );
  } else {
    const implied = impliedAxis(e.joins);
    if (e.pathAxis !== implied) {
      // Two instruments disagree. Report it and STOP trusting the numbers from
      // the one that can be fooled, rather than compounding a bad read into a
      // confident verdict. road_ramp is the live case: from directly above its
      // sloped side skirts are the same grey as its tarmac, so the probe reads
      // all four edges and a 1.00 m lane, both wrong.
      eyes(
        `declared pathAxis "${e.pathAxis}" disagrees with the measured joins ` +
          `[${e.joins.join(", ")}], which imply "${implied}" — one of the two is wrong; the numbers ` +
          `below are withheld until a human settles it`,
      );
    } else {
      trusted = true;
    }
    // A piece NAMED as a corner whose road enters and leaves on OPPOSITE edges
    // is a chicane. The most expensive kind of mislabel: it looks usable, so a
    // child keeps prompting at a problem that cannot be solved.
    if (/curve|corner|bend|turn/.test(e.name) && implied !== "none") {
      reasons.push(
        `name promises a turn but the measured joins [${e.joins.join(", ")}] are OPPOSITE edges — ` +
          `this is a chicane (a lateral shift), not a corner`,
      );
      if (verdict === "pass") verdict = "needs-eyes";
    }
  }

  // --- Lane: will it mate the kit it ships with? ------------------------
  // Applies to tiles AND props: a gantry whose span does not match the road it
  // straddles is wrong in exactly the way a mismatched tile is.
  if (trusted && typeof e.lane === "number" && lane !== undefined && Math.abs(e.lane - lane) > LANE_TOLERANCE_M) {
    fail(
      `carriageway ${e.lane} m does not match its kit's ${lane} m — the pieces will visibly ` +
        `step in and out where they meet, at every scale`,
    );
  }

  // --- Grid: tiles only -------------------------------------------------
  // A `prop` straddles the road without tiling it, so its footprint may
  // overhang and neither rule below applies. finish_line is 1.26 m wide on a
  // 1 m module and is CORRECT — the overhang is verge over grass.
  if (e.pathRole === "prop" || module === undefined) return { ...base, verdict, reasons };
  if (e.pathRole === undefined) {
    eyes("no pathRole declared — cannot tell a grid tile from a road prop, so the grid rules are skipped");
    return { ...base, verdict, reasons };
  }

  for (const [axis, value] of [
    ["X", e.size[0]],
    ["Z", e.size[2]],
  ] as const) {
    if (!isMultiple(value, module)) {
      fail(
        `${axis} footprint ${value} m is not a whole multiple of the ${e.kit ?? "kit"} module ` +
          `(${module} m) — it cannot meet its neighbours at ANY scale or rotation, so no prompt can rescue it`,
      );
    }
  }

  // Every join must sit at a CELL CENTRE, (k + 1/2) x module from the piece's
  // own minimum. This is the rule that separates road_curve (0.50 m and 1.50 m
  // on a 2 m tile — both cell centres, a valid sweeping turn) from
  // race_track_curve (0.50 m and 1.00 m — the second is a cell BOUNDARY, so
  // nothing on the grid can follow it). Their `joins` and `lane` are identical;
  // only the offsets tell them apart.
  if (trusted && e.joinOffsets) {
    for (const [edge, offset] of Object.entries(e.joinOffsets)) {
      const cells = offset / module - 0.5;
      if (Math.abs(cells - Math.round(cells)) * module > MODULE_TOLERANCE_M) {
        fail(
          `the ${edge} carriageway sits ${offset} m from the piece's edge, which is a cell ` +
            `BOUNDARY on the ${module} m grid, not a cell centre — no on-grid piece can connect to it`,
        );
      }
    }
  }

  return { ...base, verdict, reasons };
}

/** The standing sweep (PRD §4, Layer 1). Path pieces only — holding actors and
 *  scenery to a module contract would bury the real findings in noise, which is
 *  how a gate stops being read. */
export function assessLibrary(all: AssetEntry[]): FitnessFinding[] {
  return all
    .filter(isPathPiece)
    .map((e) => assessModel(e, all))
    .filter((f) => f.verdict !== "not-a-path-piece");
}
