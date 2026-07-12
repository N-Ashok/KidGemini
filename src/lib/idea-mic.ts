// Mic tab state machine (docs/PRD-IDEA-BUTTON.md). The tab half-tucks into the
// preview's edge so it can never fight the game's own controls: a stray click
// only slides it out; only a second deliberate click starts listening; ending
// a session is always the explicit ✅/🗑 choice (kids double-tap — a toggle
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
