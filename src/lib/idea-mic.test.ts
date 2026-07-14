// Mic tab state machine (docs/PRD-IDEA-BUTTON.md): the tab docks near the top
// of the preview edge, fully visible, so it can never fight the game's own
// (usually bottom/center) controls — a stray click only slides it OUT; only a
// second deliberate click starts listening. ✅ Got it! keeps listening (a kid
// with several ideas shouldn't have to re-tap between each one); 🗑 Never mind
// still ends the session.
import { describe, expect, it } from "vitest";
import { nextMicTabState, type MicTabEvent, type MicTabState } from "./idea-mic";

describe("nextMicTabState — full transition table", () => {
  const table: Array<[MicTabState, MicTabEvent, MicTabState]> = [
    // A stray click near the edge is harmless: it only reveals the tab.
    ["tucked", "tabClick", "out"],
    ["out", "tabClick", "listening"],
    // Clicking the tab while listening is NOT a toggle — kids double-tap;
    // ending the session must be the explicit ✅ / 🗑 choice.
    ["listening", "tabClick", "listening"],
    // ✅ Got it! keeps listening (2026-07-14) — a kid saying several ideas in
    // a row shouldn't have to re-tap the tab between each one. 🗑 Never mind
    // still tucks away (discard, and stop).
    ["listening", "got", "listening"],
    ["listening", "never", "tucked"],
    ["out", "got", "tucked"],
    ["out", "never", "tucked"],
    ["tucked", "got", "tucked"],
    ["tucked", "never", "tucked"],
    // Auto-tuck after idling slid-out; never interrupts active listening.
    ["out", "dismiss", "tucked"],
    ["listening", "dismiss", "listening"],
    ["tucked", "dismiss", "tucked"],
    // Fatal mic error (permission/hardware): stop listening but stay OUT so
    // the kid sees the friendly error next to the tab.
    ["listening", "fatalError", "out"],
    ["out", "fatalError", "out"],
    ["tucked", "fatalError", "tucked"],
  ];

  it.each(table)("%s + %s → %s", (from, ev, to) => {
    expect(nextMicTabState(from, ev)).toBe(to);
  });
});
