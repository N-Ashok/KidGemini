// Mic tab state machine (docs/PRD-IDEA-BUTTON.md). "Tucked" is the resting
// state — docked near the top of the preview edge, fully visible, out of the
// way of a game's own controls (usually bottom/center). A stray click only
// slides it out; only a second deliberate click starts listening; ending a
// session is always the explicit ✅/🗑 choice (kids double-tap — a toggle
// would eat half their sentences). Framework-free so it's unit-testable.

export type MicTabState = "tucked" | "out" | "listening";

export type MicTabEvent =
  | "tabClick" // the tab itself
  | "got" // ✅ Got it! — idea committed to the bag
  | "never" // 🗑 Never mind — transcript discarded
  | "dismiss" // idle auto-tuck while slid out
  | "fatalError"; // mic permission/hardware — stop, but stay visible with the error

export function nextMicTabState(state: MicTabState, event: MicTabEvent): MicTabState {
  switch (event) {
    case "tabClick":
      return state === "tucked" ? "out" : state === "out" ? "listening" : "listening";
    case "got":
      // Stay listening (2026-07-14): a kid with several ideas shouldn't have
      // to re-tap the tab between each one. Only reachable from "listening"
      // via the UI (the ✅ button only renders there); other states fall
      // back to "tucked" as a safe no-op.
      return state === "listening" ? "listening" : "tucked";
    case "never":
      return "tucked";
    case "dismiss":
      return state === "out" ? "tucked" : state;
    case "fatalError":
      return state === "tucked" ? "tucked" : "out";
  }
}

/** Idle gap before a slid-out (not listening) tab tucks itself away. */
export const TAB_AUTO_TUCK_MS = 6000;

/** The tab's starting state on mount. A pendingDraft (BUG-FIX-LOG: a verify/
 *  repair cover unmounting the tab mid-capture) reopens straight into the
 *  review bar — the kid sees exactly what they said and can edit/finish/
 *  discard it, never having it silently dropped OR auto-queued unreviewed. */
export function initialMicTabState(pendingDraft: string | null | undefined): MicTabState {
  return pendingDraft?.trim() ? "listening" : "tucked";
}

/** Feature kill switch (owner decision 2026-07-31): the one-tap mic tab makes
 *  game-building feel too effortless to register as an accomplishment — the
 *  owner wants kids to reach the chat and say what they want in their own
 *  words rather than have a floating shortcut do it for them. Code stays in
 *  place, just gated off by default, so it can be re-enabled from feedback
 *  without rebuilding it. BUILD-TIME GOTCHA (BUG-FIX-LOG 2026-07-31): Next.js
 *  only inlines a NEXT_PUBLIC_* var into the client bundle when the literal
 *  expression `process.env.NEXT_PUBLIC_X` appears at the call site — callers
 *  MUST pass that literal, not a bare `ideaMicEnabled()`. */
export function ideaMicEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PUBLIC_ENABLE_IDEA_MIC === "1";
}
