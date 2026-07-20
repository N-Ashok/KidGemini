// PRD §13 rows V.10, R.2, R.3 — the pure retry/bail policy.
import { describe, it, expect } from "vitest";
import {
  MAX_REPAIR_ATTEMPTS,
  WALL_CLOCK_CAP_MS,
  repairEnabled,
  shouldRepair,
  shouldStartVerify,
  verifyOutcome,
} from "./verify-policy";

describe("shouldStartVerify (V.10)", () => {
  it("skips verify entirely when the document is hidden at start", () => {
    expect(shouldStartVerify(true)).toBe(false);
    expect(shouldStartVerify(false)).toBe(true);
  });
});

describe("shouldRepair", () => {
  const base = { code: "load_error", enabled: true };

  it("R.2 — caps at 2 attempts: a third is never issued", () => {
    expect(shouldRepair({ ...base, attempt: 0, elapsedMs: 1000 })).toBe(true);
    expect(shouldRepair({ ...base, attempt: 1, elapsedMs: 1000 })).toBe(true);
    expect(shouldRepair({ ...base, attempt: MAX_REPAIR_ATTEMPTS, elapsedMs: 1000 })).toBe(false);
  });

  it("R.3 — past the 20s wall clock it bails even with attempts left", () => {
    expect(shouldRepair({ ...base, attempt: 0, elapsedMs: WALL_CLOCK_CAP_MS })).toBe(false);
    expect(shouldRepair({ ...base, attempt: 0, elapsedMs: WALL_CLOCK_CAP_MS - 1 })).toBe(true);
  });

  it("kill switch (rollout step 2, instrument-only) disables repair", () => {
    expect(shouldRepair({ ...base, attempt: 0, elapsedMs: 0, enabled: false })).toBe(false);
    expect(repairEnabled({ NEXT_PUBLIC_PREVIEW_REPAIR: "0" })).toBe(false);
    expect(repairEnabled({})).toBe(true);
  });

  // REGRESSION (BUG-FIX-LOG 2026-07-20, false repair of a running game): a
  // benign error (audio-autoplay rejection is the archetype) classified as a
  // repairable code must NOT spend a Gemini call when the probes saw the game
  // demonstrably running — the "repair" replaced a healthy game with a
  // drifted patch, burned both attempts, and ended in the give-up banner.
  it("a demonstrably-running game is never repaired, whatever the code says", () => {
    for (const code of ["load_error", "async_loop", "resource_404", "start_occluded"]) {
      expect(
        shouldRepair({ code, attempt: 0, elapsedMs: 0, enabled: true, demonstrablyRunning: true }),
      ).toBe(false);
    }
    // Absent/false keeps today's behavior — fail toward repairing real breaks.
    expect(
      shouldRepair({ code: "load_error", attempt: 0, elapsedMs: 0, enabled: true, demonstrablyRunning: false }),
    ).toBe(true);
  });

  it("only hard-evidence codes may spend a Gemini call (false-repair UAT, 2026-07-10)", () => {
    for (const code of ["load_error", "async_loop", "resource_404", "start_occluded"]) {
      expect(shouldRepair({ code, attempt: 0, elapsedMs: 0, enabled: true })).toBe(true);
    }
    // Probe-inference codes are telemetry-only until live data proves them:
    // a healthy downloaded game was falsely "repaired" as canvas_static.
    for (const code of ["canvas_static", "no_loop", "start_no_loop", "canvas_zero_size", "no_start_button"]) {
      expect(shouldRepair({ code, attempt: 0, elapsedMs: 0, enabled: true })).toBe(false);
    }
  });
});

describe("verifyOutcome (§11 telemetry)", () => {
  it("maps run endings to the preview_verify outcome prop", () => {
    expect(verifyOutcome({ finalCode: "clean", attempts: 0, bailed: false })).toBe("clean");
    expect(verifyOutcome({ finalCode: "clean", attempts: 1, bailed: false })).toBe("repaired");
    expect(verifyOutcome({ finalCode: "start_occluded", attempts: 2, bailed: false })).toBe("failed");
    expect(verifyOutcome({ finalCode: "no_loop", attempts: 1, bailed: true })).toBe("bailed");
  });
});
