// BUG-FIX-LOG 2026-07-10 "long speech lost — only the last sentence arrives":
// with interimResults=false the browser only delivers FINALIZED segments, and
// a long unbroken monologue may finalize nothing — when the session hard-ends
// mid-speech everything recognized so far was silently discarded. The fix
// captures interims and FLUSHES the pending interim when a session ends.
import { describe, it, expect } from "vitest";
import { composeDictation, splitSpeechResults } from "./speech-transcript";

type Result = ArrayLike<{ transcript: string }> & { isFinal?: boolean };
const final = (t: string): Result => Object.assign([{ transcript: t }], { isFinal: true, length: 1 });
const interim = (t: string): Result => Object.assign([{ transcript: t }], { isFinal: false, length: 1 });

describe("splitSpeechResults", () => {
  it("emits only NEW final segments (resultIndex onward), not the whole session", () => {
    const { freshFinalText } = splitSpeechResults([final("make me a game"), final("with a dragon")], 1);
    expect(freshFinalText).toBe("with a dragon");
  });

  it("keeps not-yet-final speech as interim instead of dropping it", () => {
    // One event: segment 0 just finalized, segment 1 still being spoken.
    const { freshFinalText, interimText } = splitSpeechResults(
      [final("make me a game"), interim("with a huge castle and")],
      0,
    );
    expect(freshFinalText).toBe("make me a game");
    expect(interimText).toBe("with a huge castle and");
  });

  it("an already-delivered final is NOT re-emitted when a later interim updates", () => {
    const { freshFinalText, interimText } = splitSpeechResults(
      [final("make me a game"), interim("with a huge castle and")],
      1, // change starts at the interim — index 0 was emitted in a prior event
    );
    expect(freshFinalText).toBe("");
    expect(interimText).toBe("with a huge castle and");
  });

  it("a long monologue with NO finals yet is all interim — nothing is lost", () => {
    const { freshFinalText, interimText } = splitSpeechResults([interim("a really long wish that never pauses")], 0);
    expect(freshFinalText).toBe("");
    expect(interimText).toBe("a really long wish that never pauses");
  });

  it("interim reflects the CURRENT tail, so a finalized segment never doubles", () => {
    // Same utterance first seen as interim, then final: interim must be empty.
    const { freshFinalText, interimText } = splitSpeechResults([final("with a dragon")], 0);
    expect(freshFinalText).toBe("with a dragon");
    expect(interimText).toBe("");
  });

  it("missing resultIndex defaults to 0 (older WebKit)", () => {
    const { freshFinalText } = splitSpeechResults([final("hello there")], undefined);
    expect(freshFinalText).toBe("hello there");
  });

  it("multiple fresh finals join with spaces; blank alternatives are skipped", () => {
    const empty: Result = Object.assign([], { isFinal: true, length: 0 });
    const { freshFinalText } = splitSpeechResults([final("one"), empty, final("two")], 0);
    expect(freshFinalText).toBe("one two");
  });
});

describe("composeDictation (live typing while the kid speaks)", () => {
  it("appends the live interim after the committed text with one space", () => {
    expect(composeDictation("make me a game", "with a dragon")).toBe("make me a game with a dragon");
  });

  it("interim alone shows as-is (nothing committed yet)", () => {
    expect(composeDictation("", "make me a")).toBe("make me a");
  });

  it("no interim → exactly the committed text (typing path unchanged)", () => {
    expect(composeDictation("hello", "")).toBe("hello");
    expect(composeDictation("", "")).toBe("");
  });
});
