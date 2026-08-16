// Count what a child can SEE in a game, so a "make it faster" fix can never
// quietly empty their world (2026-08-16).
//
// WHY: the proactive draw-call fix stripped every mesh out of a child's game
// while she was playing it. That path is now off, but the tap-to-fix banner
// sends the SAME hint — "merge repeated things into one InstancedMesh" — and
// the same edit is possible. Owner: "autofix making the game bad is not
// acceptable." So the guard belongs on the RESULT, not on the trigger.
//
// THE HARD PART: a CORRECT instancing fix legitimately deletes hundreds of
// `new Mesh(...)` calls — that is the whole point of it. Counting construction
// calls would therefore reject exactly the fix we asked for. So this counts
// COPIES IN THE WORLD instead:
//
//   loadModel("tree")                -> 1 tree
//   placeModel("tree", …)            -> 1 tree
//   loadModelBatch("tree", 40)       -> 40 trees
//   new InstancedMesh(geo, mat, 200) -> 200 things
//   new Mesh(…)                      -> 1 thing
//
// Under that lens a real instancing fix is roughly CONSERVATIVE — 200 meshes
// become one InstancedMesh of 200 — while a deletion is unmistakable.
//
// Deliberately a heuristic over source text, not a scene graph: it runs before
// the game is ever shown, on a string, with no browser. It is designed to be
// WRONG IN THE SAFE DIRECTION — when it cannot tell, it does not claim a
// regression, because refusing a good fix costs the child a slow game while
// accepting a bad one costs them the game itself. The one thing it treats as
// certain is a model name that was there and is now gone.

export interface SceneCensus {
  /** Copies per library model name, e.g. { tree: 40, car: 1 }. */
  models: Record<string, number>;
  /** Hand-built things: `new Mesh` counts 1, `new InstancedMesh(…, n)` counts n. */
  handBuilt: number;
  /** Every visible copy the source asks for. */
  total: number;
}

const LOAD_ONE_RE = /\b(?:loadModel|placeModel)\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
const LOAD_BATCH_RE = /\bloadModelBatch\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*,\s*(\d+)/g;
const INSTANCED_RE = /\bnew\s+InstancedMesh\s*\([^)]*?,\s*(\d+)\s*\)/g;
const MESH_RE = /\bnew\s+Mesh\s*\(/g;

/** A batch count far above anything real is a typo or a generated absurdity;
 *  clamp so one bad number cannot swamp the comparison. */
const MAX_COUNTED_PER_CALL = 5_000;

export function sceneCensus(html: string): SceneCensus {
  const models: Record<string, number> = {};
  if (!html) return { models, handBuilt: 0, total: 0 };

  const add = (name: string, n: number) => {
    models[name] = (models[name] ?? 0) + Math.min(n, MAX_COUNTED_PER_CALL);
  };

  for (const m of html.matchAll(LOAD_BATCH_RE)) add(m[1]!, Number(m[2]));
  // Single loads: skip the ones already counted as a batch call, since
  // loadModelBatch also matches loadModel's prefix... it does not (the regex
  // requires the full identifier), but a batch call ALSO names the model, so
  // count singles only from loadModel/placeModel, which LOAD_ONE_RE does.
  for (const m of html.matchAll(LOAD_ONE_RE)) add(m[1]!, 1);

  let handBuilt = 0;
  for (const m of html.matchAll(INSTANCED_RE)) handBuilt += Math.min(Number(m[1]), MAX_COUNTED_PER_CALL);
  handBuilt += (html.match(MESH_RE) ?? []).length;

  const total = handBuilt + Object.values(models).reduce((a, b) => a + b, 0);
  return { models, handBuilt, total };
}

export interface CensusVerdict {
  regressed: boolean;
  /** Plain-language reason, for the log. Empty when nothing regressed. */
  reason: string;
}

/**
 * Fraction of the world a fix may remove before we call it a regression.
 *
 * A genuine instancing fix keeps the copies and merges the draw calls, so it
 * lands near 1.0. Set at 0.6 — a fix that leaves less than 60% of what the
 * child had is not tidying, it is deleting.
 */
export const CENSUS_FLOOR_RATIO = 0.6;

/** A scene this small is below the noise floor; ratios on tiny numbers say
 *  nothing, so only the disappearing-name rule applies. */
const MIN_TOTAL_FOR_RATIO = 10;

/**
 * Did a fix make the game worse?
 *
 * Two rules, both about what the child loses:
 *  1. A library model that WAS in the game is now absent entirely. This is the
 *     "all the meshes were gone" failure and needs no threshold — she asked
 *     for a dinosaur and the dinosaur is gone.
 *  2. The world shrank below CENSUS_FLOOR_RATIO of what it was.
 */
export function censusRegression(beforeHtml: string, afterHtml: string): CensusVerdict {
  const before = sceneCensus(beforeHtml);
  const after = sceneCensus(afterHtml);

  const vanished = Object.keys(before.models).filter((name) => !after.models[name]);
  if (vanished.length > 0) {
    return {
      regressed: true,
      reason: `models removed: ${vanished.sort().join(", ")}`,
    };
  }

  if (before.total >= MIN_TOTAL_FOR_RATIO && after.total < before.total * CENSUS_FLOOR_RATIO) {
    return {
      regressed: true,
      reason: `scene shrank from ${before.total} to ${after.total} things`,
    };
  }

  return { regressed: false, reason: "" };
}
