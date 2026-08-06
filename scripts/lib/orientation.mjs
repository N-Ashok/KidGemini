// Library facing convention: every VEHICLE model faces +Z at rest, so one
// shared `rotation.y` steers the whole library (BUG-FIX-LOG 2026-08-06 — the
// sideways black bike: street_motorcycle shipped authored nose-at-+X, and no
// game-code iteration can ever fix an asset's invisible rest orientation).
//
// Used by scripts/vendor-models.mjs:
//  - `assertLongAxis: 'z'` on a model entry runs assertLongAxisZ after the
//    transform pipeline — a sideways vehicle FAILS curation with a fix-it
//    message instead of shipping.
//  - `rotateYDeg: <deg>` bakes a Y rotation into the root nodes via
//    yRotation() — the fix the lint message prescribes.
//
// Pure math, no gltf-transform imports — unit-tested from
// src/lib/assets/orientation-lint.test.ts.

/** 'x' | 'z' — which HORIZONTAL axis is longer (Y is height, never facing). */
export function longHorizontalAxis({ min, max }) {
  const x = max[0] - min[0];
  const z = max[2] - min[2];
  return x > z ? "x" : "z";
}

/** Curation gate: a vehicle whose long axis is X is authored sideways. */
export function assertLongAxisZ(name, bounds) {
  if (longHorizontalAxis(bounds) === "x") {
    const x = (bounds.max[0] - bounds.min[0]).toFixed(2);
    const z = (bounds.max[2] - bounds.min[2]).toFixed(2);
    throw new Error(
      `${name}: long axis is X (${x} m vs Z ${z} m) — vehicle authored sideways. ` +
        `Library convention is nose at +Z. Add rotateYDeg (-90 if the nose is at +X, ` +
        `+90 if at -X) to the model entry and re-run; verify with a render.`,
    );
  }
}

/** Y-rotation toolkit for baking a facing fix into root nodes.
 *  Returns { quat, rotateVec, composeQuat }:
 *   - quat: [x,y,z,w] for the rotation, gltf-transform order
 *   - rotateVec([x,y,z]): the rotation applied to a translation
 *   - composeQuat(nodeQuat): bake ∘ node — the node keeps its own spin,
 *     then the whole thing turns by the bake angle. */
export function yRotation(deg) {
  const half = (deg * Math.PI) / 360;
  const s = Math.sin(half);
  const c = Math.cos(half);
  const quat = [0, s, 0, c];
  const rad = (deg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const rotateVec = ([x, y, z]) => [x * cosR + z * sinR, y, -x * sinR + z * cosR];
  const composeQuat = ([qx, qy, qz, qw]) => {
    // Hamilton product quat * node ([0,s,0,c] * [qx,qy,qz,qw]).
    return [
      c * qx + s * qz,
      c * qy + s * qw,
      c * qz - s * qx,
      c * qw - s * qy,
    ];
  };
  return { quat, rotateVec, composeQuat };
}
