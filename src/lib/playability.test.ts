// Playability judgement (docs/BUG-FIX-LOG.md 2026-08-29, the fairy puzzle).
// A game can throw ZERO errors, pass every mechanical check, and still be
// impossible to play. The browser half lives in scripts/verify-game-html.mjs;
// the DECISION is pure and lives here so it can be tested without a browser.
import { describe, it, expect } from "vitest";
import { sampleDistance, judgePlayability, findFrozenStateRisks, IDLE_MARGIN, MIN_CHANGED } from "../../scripts/playability.mjs";

const flat = (v: number) => Array.from({ length: 64 }, () => v);
const withBlob = (v: number, at: number, n = 6) => flat(v).map((x, i) => (i >= at && i < at + n ? 255 : x));

describe("sampleDistance", () => {
  it("PL.1 is 0 for identical frames and grows with the area that changed", () => {
    expect(sampleDistance(flat(10), flat(10))).toBe(0);
    const small = sampleDistance(flat(10), withBlob(10, 0, 2));
    const big = sampleDistance(flat(10), withBlob(10, 0, 20));
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
  });
  it("PL.2 mismatched or empty samples are 0, never NaN", () => {
    expect(sampleDistance([], [])).toBe(0);
    expect(sampleDistance(flat(1), [1, 2, 3])).toBe(0);
  });
});

describe("judgePlayability", () => {
  const idle = 0.002; // a hovering sprite / particles with NO input

  it("PL.3 a game whose screen never changes on input is unplayable", () => {
    const v = judgePlayability({ idle, afterFirstInput: 0.0005, forwardVsBack: 0.0005 });
    expect(v.playable).toBe(false);
    expect(v.reason).toMatch(/no visible change|never moves/i);
  });

  it("PL.4 THE FAIRY BUG: it moves once, then opposite inputs leave the screen identical", () => {
    // The real defect — player.x was only committed inside the renderer, behind
    // `animProgress > 1`, which is false at exactly 1.0. So the first step drew,
    // and every later move recomputed from a stale position.
    const v = judgePlayability({ idle, afterFirstInput: 0.05, forwardVsBack: 0.0021 });
    expect(v.playable).toBe(false);
    expect(v.reason).toMatch(/frozen|opposite/i);
  });

  it("PL.5 a genuinely playable game passes", () => {
    expect(judgePlayability({ idle, afterFirstInput: 0.05, forwardVsBack: 0.04 }).playable).toBe(true);
  });

  it("PL.6 idle animation alone never counts as movement — the margin is over IDLE, not over zero", () => {
    // Particles/hover make every frame differ slightly; that must not read as
    // a working control scheme.
    const noisy = 0.02;
    expect(judgePlayability({ idle: noisy, afterFirstInput: noisy * 1.1, forwardVsBack: noisy * 1.1 }).playable).toBe(false);
    expect(judgePlayability({ idle: noisy, afterFirstInput: noisy * IDLE_MARGIN * 1.2, forwardVsBack: noisy * IDLE_MARGIN * 1.2 }).playable).toBe(true);
  });

  it("PL.7 a still game (no idle animation) still needs a real change, not one stray pixel", () => {
    const v = judgePlayability({ idle: 0, afterFirstInput: MIN_CHANGED / 2, forwardVsBack: MIN_CHANGED / 2 });
    expect(v.playable).toBe(false);
  });
});

// The high-precision half. The pixel probe could not tell the broken fairy
// game from the fixed one (idle sparkle animation swamped a one-tile move),
// and the HUD probe is only a POSITIVE signal. This lint is deterministic and
// catches the exact defect: a float accumulator gated by a strict `>`, so the
// state commit never fires when the accumulator lands on the boundary.
describe("findFrozenStateRisks — the fairy bug, statically", () => {
  it("PL.8 flags `x += 0.2` guarded by `x > 1` (the shipped defect, verbatim shape)", () => {
    const hits = findFrozenStateRisks(`
      function drawPlayer() {
        if (player.animProgress < 1) {
          player.animProgress += 0.2;
          if (player.animProgress > 1) {
            player.animProgress = 1;
            player.x = player.targetX;
          }
        }
      }`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/animProgress/);
    expect(hits[0]).toMatch(/>=/);
  });

  it("PL.9 does NOT flag the correct form `>= 1`", () => {
    expect(findFrozenStateRisks("t += 0.25; if (t >= 1) { commit(); }")).toEqual([]);
  });

  it("PL.10 does NOT flag integer counters or unrelated comparisons", () => {
    expect(findFrozenStateRisks("lives += 1; if (lives > 1) {}")).toEqual([]);
    expect(findFrozenStateRisks("if (speed > 1) {} ")).toEqual([]);
    expect(findFrozenStateRisks("p += 0.2; if (other > 1) {}")).toEqual([]);
  });

  it("PL.11 catches the same bug written with a different step and spacing", () => {
    expect(findFrozenStateRisks("this.t+=0.05;\nif(this.t>1){this.x=this.tx;}")).toHaveLength(1);
  });
});
