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
  it("R.2 — caps at 2 attempts: a third is never issued", () => {
    expect(shouldRepair({ attempt: 0, elapsedMs: 1000, enabled: true })).toBe(true);
    expect(shouldRepair({ attempt: 1, elapsedMs: 1000, enabled: true })).toBe(true);
    expect(shouldRepair({ attempt: MAX_REPAIR_ATTEMPTS, elapsedMs: 1000, enabled: true })).toBe(false);
  });

  it("R.3 — past the 20s wall clock it bails even with attempts left", () => {
    expect(shouldRepair({ attempt: 0, elapsedMs: WALL_CLOCK_CAP_MS, enabled: true })).toBe(false);
    expect(shouldRepair({ attempt: 0, elapsedMs: WALL_CLOCK_CAP_MS - 1, enabled: true })).toBe(true);
  });

  it("kill switch (rollout step 2, instrument-only) disables repair", () => {
    expect(shouldRepair({ attempt: 0, elapsedMs: 0, enabled: false })).toBe(false);
    expect(repairEnabled({ NEXT_PUBLIC_PREVIEW_REPAIR: "0" })).toBe(false);
    expect(repairEnabled({})).toBe(true);
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
