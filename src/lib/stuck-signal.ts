// "This kid is stuck" — the decision to offer a real person
// (docs/PRD-COMMUNITY-HELP.md §3.2). Pure and I/O-free, same pattern as
// verify-policy.ts and idea-queue.ts, so the truth table is unit-testable
// without a browser and the thresholds can be retuned without touching logic.
//
// Volume control lives HERE. One admin answers these inside a 16h target
// (help-sla.ts); if tickets ever outrun that, the honest lever is raising these
// numbers, not auto-answering with something that pretends to be a person.

import { MAX_REPAIR_ATTEMPTS } from "./verify-policy";

/** Repairs spent on ONE generation before we offer a human. Matches the repair
 *  loop's own cap — by then the machine has genuinely run out of ideas. */
export const FAILED_REPAIRS_BEFORE_OFFER = MAX_REPAIR_ATTEMPTS;

/** Asks in the window with no new game to show for them. */
export const ASKS_BEFORE_OFFER = 3;
export const ASK_WINDOW_MS = 5 * 60 * 1000;

export interface StuckState {
  /** The generation currently on screen — the nudge is once per one of these.
   *  Null = nothing built yet, so there is nothing to be stuck on. */
  generationId: string | null;
  /** Repairs attempted on THIS generation that did not fix it. */
  failedRepairs: number;
  /** Verify ended failed or bailed for this generation. */
  verifyFailed: boolean;
  /** Timestamps of the kid's recent asks that produced NO artifact swap. The
   *  caller only records asks that changed nothing, so a successful build
   *  simply never lands in here. */
  asksWithoutSwap: number[];
  /** The generation we already nudged for (persisted by the caller). */
  nudgedGenerationId: string | null;
  now: number;
}

/**
 * Whether to show the one-time "want a grown-up to look at this?" nudge.
 *
 * A failed verify on its own is NOT a signal — the repair loop owns that, and
 * nudging there would send tickets for games the machine was about to fix.
 */
export function shouldOfferHelp(s: StuckState): boolean {
  if (!s.generationId) return false;
  if (s.nudgedGenerationId === s.generationId) return false;

  // 1. The machine tried everything it's allowed to try and the game is still broken.
  if (s.verifyFailed && s.failedRepairs >= FAILED_REPAIRS_BEFORE_OFFER) return true;

  // 2. The kid keeps asking and nothing changes on screen — the "it won't move
  //    and I don't know what to say to Ari" case, which no repair can reach.
  const recent = s.asksWithoutSwap.filter((t) => s.now - t <= ASK_WINDOW_MS);
  return recent.length >= ASKS_BEFORE_OFFER;
}

/**
 * PRD §3.1 ("try the machine first") needs no code here — it is satisfied
 * STRUCTURALLY. The self-healing loop runs automatically on every generation
 * and spends its attempts (verify-policy.ts: REPAIRABLE_CODES,
 * MAX_REPAIR_ATTEMPTS, the wall-clock bail) before a kid can tap 🆘 at all, so
 * by the time a ticket is filed the automated path has already had first
 * refusal. An extra "want me to try fixing it first? 🔧" button would either
 * re-run a loop that just finished, or do nothing — theatre either way.
 *
 * The property §3.1 was protecting still holds: every ticket that arrives is
 * something automation could not handle, which is what makes the reason-code
 * histogram signal rather than noise.
 */
