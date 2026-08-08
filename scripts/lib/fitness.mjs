// Pipeline copy of the asset-fitness rules — the mirror of
// src/lib/assets/fitness.ts (same split as scripts/lib/orientation.mjs vs its
// TS test). The vendor scripts are plain .mjs and cannot import the TS module,
// so the rules exist twice.
//
// TWO COPIES DRIFT. That is not a hypothetical: an earlier duplication in this
// repo shipped a manifest field the pipeline wrote as `p.pathAxis` and the
// validator read as `p.model.pathAxis`. So the drift is PINNED, not merely
// discouraged — src/lib/assets/fitness.parity.test.ts runs both copies over
// the whole committed library and fails on the first disagreement. Change one
// copy and that test tells you about the other.
//
// Keep the logic and the wording identical; the reason strings are asserted.

/** @typedef {"pass"|"fail"|"needs-eyes"|"not-a-path-piece"} Verdict */

const MODULE_TOLERANCE_M = 0.03;
const LANE_TOLERANCE_M = 0.05;

export function isPathPiece(e) {
  return e.type === 'model' && e.pathAxis !== undefined;
}

export function kitModule(kit, all) {
  const sizes = all
    .filter((a) => isPathPiece(a) && a.kit === kit && a.size)
    .flatMap((a) => [a.size[0], a.size[2]]);
  return sizes.length ? Math.min(...sizes) : undefined;
}

export function kitLane(kit, all) {
  const lanes = all
    .filter((a) => isPathPiece(a) && a.kit === kit && typeof a.lane === 'number')
    .map((a) => a.lane)
    .sort((x, y) => x - y);
  return lanes.length ? lanes[Math.floor(lanes.length / 2)] : undefined;
}

const isMultiple = (value, base) =>
  Math.abs(value / base - Math.round(value / base)) * base <= MODULE_TOLERANCE_M;

function impliedAxis(joins) {
  const set = new Set(joins);
  if (set.size === 2 && set.has('-x') && set.has('+x')) return 'x';
  if (set.size === 2 && set.has('-z') && set.has('+z')) return 'z';
  return 'none';
}

export function assessModel(e, all) {
  if (!isPathPiece(e)) return { name: e.name, verdict: 'not-a-path-piece', reasons: [] };

  const reasons = [];
  let verdict = 'pass';
  const fail = (why) => { reasons.push(why); verdict = 'fail'; };
  const eyes = (why) => { reasons.push(why); if (verdict !== 'fail') verdict = 'needs-eyes'; };

  const module = kitModule(e.kit, all);
  const lane = kitLane(e.kit, all);
  const base = { name: e.name, verdict, reasons, kit: e.kit, joins: e.joins, lane: e.lane, size: e.size, module };

  if (!e.size) {
    eyes('no measured size — skinned models cannot be measured from bind-pose bytes (TECH_DEBT #93)');
    return { ...base, verdict };
  }

  let trusted = false;
  if (!e.joins || e.joins.length === 0) {
    eyes(
      'carriageway edges have never been measured — run scripts/render-assets.mjs and ' +
        "scripts/backfill-tile-edges.mjs; without this a model can only guess a corner's rotation",
    );
  } else {
    const implied = impliedAxis(e.joins);
    if (e.pathAxis !== implied) {
      eyes(
        `declared pathAxis "${e.pathAxis}" disagrees with the measured joins ` +
          `[${e.joins.join(', ')}], which imply "${implied}" — one of the two is wrong; the numbers ` +
          `below are withheld until a human settles it`,
      );
    } else {
      trusted = true;
    }
    if (/curve|corner|bend|turn/.test(e.name) && implied !== 'none') {
      reasons.push(
        `name promises a turn but the measured joins [${e.joins.join(', ')}] are OPPOSITE edges — ` +
          `this is a chicane (a lateral shift), not a corner`,
      );
      if (verdict === 'pass') verdict = 'needs-eyes';
    }
  }

  if (trusted && typeof e.lane === 'number' && lane !== undefined && Math.abs(e.lane - lane) > LANE_TOLERANCE_M) {
    fail(
      `carriageway ${e.lane} m does not match its kit's ${lane} m — the pieces will visibly ` +
        `step in and out where they meet, at every scale`,
    );
  }

  if (e.pathRole === 'prop' || module === undefined) return { ...base, verdict, reasons };
  if (e.pathRole === undefined) {
    eyes('no pathRole declared — cannot tell a grid tile from a road prop, so the grid rules are skipped');
    return { ...base, verdict, reasons };
  }

  for (const [axis, value] of [['X', e.size[0]], ['Z', e.size[2]]]) {
    if (!isMultiple(value, module)) {
      fail(
        `${axis} footprint ${value} m is not a whole multiple of the ${e.kit ?? 'kit'} module ` +
          `(${module} m) — it cannot meet its neighbours at ANY scale or rotation, so no prompt can rescue it`,
      );
    }
  }

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

export function assessLibrary(all) {
  return all
    .filter(isPathPiece)
    .map((e) => assessModel(e, all))
    .filter((f) => f.verdict !== 'not-a-path-piece');
}
