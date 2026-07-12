// Mic tab state machine (docs/PRD-IDEA-BUTTON.md): the tab is half-tucked into
// the preview edge so it can never fight the game's own controls — a stray
// click only slides it OUT; only a second deliberate click starts listening.
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
    // ✅ Got it! and 🗑 Never mind both return to play (fully tucked).
    ["listening", "got", "tucked"],
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
