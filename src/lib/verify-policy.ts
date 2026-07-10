// Self-healing preview — retry policy (PRD §8.4, §9). Pure decisions, no I/O:
// the usePreviewVerify hook asks this module what to do next, so the caps and
// the bail rule are unit-testable without a browser.

/** Max repair attempts per generation — the third rarely converges (§9). */
export const MAX_REPAIR_ATTEMPTS = 2;

/** §8.4 bail rule: total verify+repair wall clock. OVERRIDES the attempt
 *  counter — a kid who waited this long gets the best version we have. */
export const WALL_CLOCK_CAP_MS = 20_000;

/** Kill switch for the repair loop (rollout §14: instrument-only = "0").
 *  NEXT_PUBLIC_ so the client bundle sees it; default ON. */
export function repairEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PUBLIC_PREVIEW_REPAIR !== "0";
}

/** §8.1 guard: rAF is throttled/stopped in hidden tabs — starting a verify
 *  there would "repair" healthy games. V.10: skip entirely, pass through. */
export function shouldStartVerify(documentHidden: boolean): boolean {
  return !documentHidden;
}

/**
 * Codes confident enough to SPEND A GEMINI CALL on (2026-07-10, after live
 * UAT falsely "repaired" a game that ran perfectly when downloaded): only
 * failures backed by hard browser facts — a thrown error with a stack, a
 * 404'd resource, an elementFromPoint-proven occluded Start. Probe-inference
 * codes (canvas_static, no_loop, start_no_loop, canvas_zero_size) are
 * TELEMETRY-ONLY pass-through until preview_verify data proves them reliable
 * — a false repair of a healthy game is worse than any bug we'd fix.
 */
export const REPAIRABLE_CODES: ReadonlySet<string> = new Set([
  "load_error",
  "async_loop",
  "resource_404",
  "start_occluded",
]);

export interface RepairDecisionInput {
  /** The classified failure code. */
  code: string;
  /** Repairs already attempted for this generation. */
  attempt: number;
  /** ms since the verify pass began (performance.now() delta). */
  elapsedMs: number;
  enabled: boolean;
}

/**
 * Whether a failed verify may trigger (another) repair. R.2: the cap means a
 * THIRD attempt is never issued. R.3: past the wall clock, bail regardless.
 */
export function shouldRepair(input: RepairDecisionInput): boolean {
  if (!input.enabled) return false;
  if (!REPAIRABLE_CODES.has(input.code)) return false;
  if (input.attempt >= MAX_REPAIR_ATTEMPTS) return false;
  if (input.elapsedMs >= WALL_CLOCK_CAP_MS) return false;
  return true;
}

/** Telemetry outcome for a finished run (§11 preview_verify.outcome). */
export function verifyOutcome(input: {
  finalCode: "clean" | "inconclusive" | string;
  attempts: number;
  bailed: boolean;
}): "clean" | "repaired" | "failed" | "bailed" {
  if (input.bailed) return "bailed";
  if (input.finalCode === "clean" || input.finalCode === "inconclusive") {
    return input.attempts > 0 ? "repaired" : "clean";
  }
  return "failed";
}
