// Mid-play self-heal — the decision half (2026-08-15).
//
// Owner: "we have pushed earlier that when there is an error the browser
// should automatically push to Ari and solve it. now more than ever, i see
// error reports [and broken games]."
//
// It turned out the auto-heal only ever covered LOAD time. The verify
// controller opens a round when a game is generated and closes it at first
// settle (`preview-verify-controller.ts`), after which every console message
// is discarded and the reloaded document runs with probes off. So an error
// thrown while the child is actually PLAYING was never sent to Ari at all —
// it only lit up the error affordance (red badge, Console tab, "Copy error
// details"). That is the gap this closes, by owner decision: fix it silently
// and swap the fixed game in.
//
// Everything here is a pure decision so the caps are unit-testable without a
// browser, exactly like verify-policy.ts.
//
// The guards are not decoration. Two production incidents came from
// background-triggered work firing at the wrong moment:
//  - 2026-08-11: the proactive draw-call auto-fix sent a real chat turn while
//    the child's own edit was streaming, racing the artifact update and
//    freezing the preview on a blue screen. Anything triggered by a passive
//    signal MUST check `busy` itself.
//  - 2026-07-10: a verify round "repaired" a game that ran perfectly. A false
//    repair of a working game is worse than the bug it imagines it is fixing.

import type { GameConsoleMessage } from "@/types/game-console.types";

/** One heal per game version. A second failure on the same document means the
 *  repair did not understand the fault, and repeating it just takes the game
 *  away from the child twice. */
export const MAX_MIDPLAY_HEALS_PER_DOC = 1;

/** How long after the verify cover lifts before mid-play healing arms.
 *  Errors in the first moments belong to the load path, which has its own
 *  (better-evidenced) repair loop — arming instantly would race it. */
export const MIDPLAY_ARM_DELAY_MS = 3_000;

/** A child who has been playing happily for a while and hits a stray error is
 *  not well served by having the game replaced under them. Beyond this, leave
 *  it alone and let the existing quiet affordance carry it. */
export const MIDPLAY_HEAL_WINDOW_MS = 10 * 60 * 1_000;

export interface MidPlayHealInput {
  /** Repair enabled at all (the NEXT_PUBLIC_PREVIEW_REPAIR kill switch). */
  enabled: boolean;
  /** Verify has finished for this document — mid-play means AFTER that. */
  settled: boolean;
  /** Any turn currently streaming. See the 2026-08-11 incident above. */
  busy: boolean;
  /** Heals already spent on this document. */
  healsThisDoc: number;
  /** ms since the verify cover lifted. */
  msSinceSettle: number;
  /** Hard errors captured from the game since it started playing. */
  hardErrorCount: number;
}

/**
 * Should we silently repair the game the child is playing right now?
 *
 * Deliberately conservative in every direction: no error, not settled, still
 * streaming, already healed, too early or too late — all mean "no".
 */
export function shouldHealMidPlay(input: MidPlayHealInput): boolean {
  if (!input.enabled) return false;
  if (!input.settled) return false; // the load-time repair loop owns this window
  if (input.busy) return false; // never race a turn that is already streaming
  if (input.hardErrorCount < 1) return false;
  if (input.healsThisDoc >= MAX_MIDPLAY_HEALS_PER_DOC) return false;
  if (input.msSinceSettle < MIDPLAY_ARM_DELAY_MS) return false;
  if (input.msSinceSettle > MIDPLAY_HEAL_WINDOW_MS) return false;
  return true;
}

/** A console message that means the game is genuinely BROKEN, not merely
 *  noisy.
 *
 *  DELIBERATELY STRICTER than error-report.ts's own `isHardError`, and named
 *  differently so the two are not mistaken for each other. That one gates
 *  whether to OFFER the error-details affordance — a cheap, reversible thing,
 *  so `level === "error"` (including a plain `console.error`) is the right
 *  bar. This one gates REPLACING THE GAME THE CHILD IS PLAYING, so a game
 *  that logs an error string and keeps running must not qualify: swapping it
 *  out would be the 2026-07-10 false-repair mistake with higher stakes. Only
 *  a real thrown error or an unhandled rejection counts. */
export function isBreakingError(message: GameConsoleMessage): boolean {
  return message.level === "error" && (message.kind === "error" || message.kind === "rejection");
}

/** The errors to hand the repair prompt, newest last, capped. Whole messages,
 *  not just their text: the stack and filename are what let the repair prompt
 *  find the fault instead of guessing at it. */
export function breakingErrors(messages: readonly GameConsoleMessage[]): GameConsoleMessage[] {
  return messages.filter(isBreakingError).slice(-20);
}
