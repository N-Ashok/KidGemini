// Mic tab state machine (docs/PRD-IDEA-BUTTON.md): the tab docks near the top
// of the preview edge, fully visible, so it can never fight the game's own
// (usually bottom/center) controls — a stray click only slides it OUT; only a
// second deliberate click starts listening. ✅ Got it! keeps listening (a kid
// with several ideas shouldn't have to re-tap between each one); 🗑 Never mind
// still ends the session.
import { describe, expect, it } from "vitest";
import { initialMicTabState, nextMicTabState, type MicTabEvent, type MicTabState } from "./idea-mic";

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

// BUG-FIX-LOG: a verify/repair cover unmounting IdeaMicTab mid-capture used
// to silently discard the whole transcript (discardAndStop, no handoff). The
// fix hands the interrupted text up to a pendingDraft the tab restores on
// remount — this reopens straight into "listening" (the review bar) so the
// kid sees exactly what they said and can edit/finish/discard it themselves,
// instead of either losing it or having it auto-queued unreviewed.
describe("initialMicTabState — resuming an interrupted draft", () => {
  it("opens straight into the review bar when a pending draft exists", () => {
    expect(initialMicTabState("make the dino purple")).toBe("listening");
  });

  it("ignores a whitespace-only draft (nothing worth reviewing)", () => {
    expect(initialMicTabState("   ")).toBe("tucked");
  });

  it("stays tucked with no pending draft", () => {
    expect(initialMicTabState(null)).toBe("tucked");
    expect(initialMicTabState(undefined)).toBe("tucked");
  });
});
