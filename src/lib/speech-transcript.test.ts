// BUG-FIX-LOG 2026-07-10 "long speech lost — only the last sentence arrives":
// with interimResults=false the browser only delivers FINALIZED segments, and
// a long unbroken monologue may finalize nothing — when the session hard-ends
// mid-speech everything recognized so far was silently discarded. The fix
// captures interims and FLUSHES the pending interim when a session ends.
//
// BUG-FIX-LOG 2026-07-14 "I want" → "I want I want I want" (3x, sometimes
// 30-40x): splitSpeechResults used to slice by the browser's own
// `event.resultIndex`. That field is unreliable on some browsers/webviews —
// when it doesn't advance, every newly-finalized segment replayed the WHOLE
// session's finals again, and the caller re-appended that growing blob on
// every final. Fixed by making the caller self-track how many finals it has
// already committed (`finalCount` in, `alreadyCommitted` out) instead of
// trusting resultIndex. The second param is still numerically compatible with
// a well-behaved resultIndex in the common single-event cases below, but the
// "browser lies about the index" regression test is what actually pins the fix.
import { describe, it, expect } from "vitest";
import { composeDictation, splitSpeechResults } from "./speech-transcript";

type Result = ArrayLike<{ transcript: string }> & { isFinal?: boolean };
const final = (t: string): Result => Object.assign([{ transcript: t }], { isFinal: true, length: 1 });
const interim = (t: string): Result => Object.assign([{ transcript: t }], { isFinal: false, length: 1 });

describe("splitSpeechResults", () => {
  it("emits only NEW final segments (beyond what's already committed), not the whole session", () => {
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
      1, // 1 final already committed in a prior event
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

  it("undefined already-committed count defaults to 0 (first event of a session)", () => {
    const { freshFinalText } = splitSpeechResults([final("hello there")], undefined);
    expect(freshFinalText).toBe("hello there");
  });

  it("multiple fresh finals join with spaces; blank alternatives are skipped", () => {
    const empty: Result = Object.assign([], { isFinal: true, length: 0 });
    const { freshFinalText } = splitSpeechResults([final("one"), empty, final("two")], 0);
    expect(freshFinalText).toBe("one two");
  });

  it("reports finalCount so the caller can self-track instead of trusting resultIndex", () => {
    const r = splitSpeechResults([final("one"), final("two"), interim("three")], 0);
    expect(r.finalCount).toBe(2);
  });

  it("regression (2026-07-14): a browser that never advances resultIndex does not cause repeats", () => {
    // Simulates the actual reported bug: every onresult event, the browser
    // hands back the WHOLE session's results and its resultIndex is stuck —
    // exactly what the old code trusted blindly. The caller here instead
    // tracks `committed` itself (as useSpeechInput now does) and feeds it
    // back in, regardless of what any "resultIndex" would have said.
    let committed = 0;
    const emitted: string[] = [];
    const browserEvents = [
      [final("I")],
      [final("I"), final("want")],
      [final("I"), final("want"), final("a"), final("car")],
    ];
    for (const all of browserEvents) {
      const { freshFinalText, finalCount } = splitSpeechResults(all, committed);
      if (freshFinalText) emitted.push(freshFinalText);
      committed = finalCount;
    }
    // Each word/phrase is emitted exactly once, in order — never replayed.
    expect(emitted).toEqual(["I", "want", "a car"]);
    expect(emitted.join(" ")).not.toMatch(/\bI\b.*\bI\b/); // "I" never repeats
  });

  it("regression: repeated onresult events carrying the same final do not re-emit it", () => {
    let committed = 0;
    const emitted: string[] = [];
    for (const all of [[final("I want")], [final("I want")], [final("I want")]]) {
      const { freshFinalText, finalCount } = splitSpeechResults(all, committed);
      if (freshFinalText) emitted.push(freshFinalText);
      committed = finalCount;
    }
    expect(emitted).toEqual(["I want"]); // not ["I want", "I want", "I want"]
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
