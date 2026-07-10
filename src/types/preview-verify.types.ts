// Self-healing preview types (PRD-SELF-HEALING-PREVIEW, platform docs).
// The injected verify script reports raw EVIDENCE via postMessage; the parent
// classifies it into a failure code (pure function — see lib/preview-verify.ts).

import type { GameConsoleMessage } from "./game-console.types";

/** §7 failure taxonomy. `no_start_button` is classified as `no_loop` in v1
 *  (same observation, same kid line); it stays in the union so the repair
 *  table can address it if classification later distinguishes them. */
export type VerifyFailureCode =
  | "load_error"
  | "async_loop"
  | "resource_404"
  | "no_loop"
  | "canvas_zero_size"
  | "canvas_static"
  | "start_occluded"
  | "start_no_loop"
  | "no_start_button";

export type VerifyClassification =
  | { code: "clean" }
  /** Tab hidden / verify interrupted — never repair on an inconclusive read. */
  | { code: "inconclusive" }
  | { code: VerifyFailureCode; evidence: VerifyEvidence; errors: GameConsoleMessage[] };

/** Raw probe evidence posted by the injected verify script (§5–§6). */
export interface VerifyEvidence {
  /** rAF calls observed by the wrapper when the settle timer fired (P1). */
  rafCountAtSettle: number;
  /** rAF calls at the moment the final result was posted. */
  rafCountFinal: number;
  /** setInterval registrations — interval-driven loops count as running (a
   *  healthy non-rAF game must not read as "dead"). */
  intervalCount?: number;
  /** Largest canvas's bitmap size, or null when the game has no canvas (P2). */
  canvas: { width: number; height: number } | null;
  /** P3 — null when skipped (no loop / no canvas); "tainted" is inconclusive. */
  pixel: "changing" | "static" | "tainted" | null;
  /** P3b — re-sample after the start probe clicked, for the static-TITLE-SCREEN
   *  case: a loop that idles on a start screen is static by design, not broken. */
  pixelAfterClick?: "changing" | "static" | "tainted" | null;
  /** P4–P6 — null when the start probe never ran (loop was already running). */
  start: {
    found: boolean;
    x?: number;
    y?: number;
    /** P5: elementFromPoint(center) was not the control (or inside it). */
    occluded?: boolean;
    /** Simple selector of the element that swallowed the tap, when occluded. */
    occluder?: string | null;
    /** P6: rAF delta in the wait window after a direct .click() dispatch. */
    clickRafDelta?: number | null;
  } | null;
}

/** Progressive checks power the §8.3 "Testing your game…" honest checklist. */
export type VerifyCheckId = "loop" | "canvas" | "drawing" | "start";

export type VerifyScriptEvent =
  | { type: "check"; check: VerifyCheckId; ok: boolean }
  | { type: "result"; evidence: VerifyEvidence };

/** postMessage envelope from the injected verify script. */
export interface VerifyPostedEvent {
  source: "kidgemini-preview-verify";
  event: VerifyScriptEvent;
}

/** Parent → iframe handshake: both injected scripts buffer everything they
 *  capture until this arrives (the parent's message listener mounts in an
 *  effect, so an unbuffered first post could race it and vanish). */
export interface ParentReadyMessage {
  source: "kidgemini-parent";
  type: "ready";
  /** false = flush captures but DO NOT probe (post-verify reload — probing
   *  again would ghost-click the kid's Start button). Absent = true. */
  verify?: boolean;
}

/** Where a verify run ended, for telemetry (§11). */
export type VerifyOutcome = "clean" | "repaired" | "failed" | "bailed" | "skipped";

/** POST /api/repair request body. */
export interface RepairRequest {
  html: string;
  failureCode: VerifyFailureCode;
  evidence: VerifyEvidence | null;
  /** Structured error lines that led to the classification, if any. */
  errors: GameConsoleMessage[];
  /** The kid's original ask — every repair prompt carries it (§7). */
  originalRequest: string;
}

/** POST /api/repair response body. */
export interface RepairResponse {
  patchedHtml?: string;
  /** "patch" = SEARCH/REPLACE applied; "regeneration" = model returned a full file. */
  mode?: "patch" | "regeneration";
  error?: string;
}
