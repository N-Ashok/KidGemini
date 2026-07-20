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
import { composeDictation, committedCountAfterRestart, splitSpeechResults } from "./speech-transcript";

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

describe("committedCountAfterRestart (2026-07-16 repeat-mic regression, take 2)", () => {
  it("a successful restart gets a fresh (zeroed) counter", () => {
    expect(committedCountAfterRestart(true, 5)).toBe(0);
  });

  it("a FAILED restart (old session never tore down) keeps the old count", () => {
    expect(committedCountAfterRestart(false, 5)).toBe(5);
  });

  it("regression: unconditionally zeroing on a failed restart replays already-committed finals", () => {
    // The old (buggy) code path: reset to 0 no matter what `rec.start()` did.
    const oldBehaviorAlwaysResets = (_startSucceeded: boolean, _previous: number) => 0;
    let committed = 0;
    const emitted: string[] = [];
    // Session 1: kid says "I want" (finalized), then the browser ends the
    // session on a silence gap. Our restart races the browser's own teardown
    // — start() throws "already started" (session 1 is still alive).
    ({ finalCount: committed } = splitSpeechResults([final("I want")], committed));
    const startSucceeded = false; // simulates `rec.start()` throwing
    committed = oldBehaviorAlwaysResets(startSucceeded, committed);
    // Session 1 (never actually restarted) keeps running and finalizes more.
    const r2 = splitSpeechResults([final("I want"), final("a car")], committed);
    if (r2.freshFinalText) emitted.push(r2.freshFinalText);
    expect(emitted).toEqual(["I want a car"]); // buggy: replays "I want"

    // Same scenario with the FIXED decision function.
    committed = 0;
    const emittedFixed: string[] = [];
    ({ finalCount: committed } = splitSpeechResults([final("I want")], committed));
    committed = committedCountAfterRestart(startSucceeded, committed);
    const r2Fixed = splitSpeechResults([final("I want"), final("a car")], committed);
    if (r2Fixed.freshFinalText) emittedFixed.push(r2Fixed.freshFinalText);
    expect(emittedFixed).toEqual(["a car"]); // fixed: "I want" never replays
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

// Repeat-mic take 3 (2026-07-18, e2e-mic-dictation.mjs finding): the take-2
// fix defends a FAILED restart, but a SUCCESSFUL restart legitimately resets
// the counter to 0 — and if a lingering old session then resurfaces (restart
// race later in the same listen), its cumulative finals all re-commit past
// the zeroed counter. Counters can't tell "fresh session's new list" from
// "old session's stale list", so the caller now also passes the committed
// TEXTS: two or more consecutive already-committed finals reappearing at the
// head of the fresh slice are a replay, and are dropped.
describe("splitSpeechResults — committed-text replay guard (take 3)", () => {
  const final = (t: string) => Object.assign([{ transcript: t }], { isFinal: true as const });

  it("drops a >=2-segment replay of already-committed finals after a counter reset", () => {
    const committedTexts = ["make me a maze game", "with penguins", "in 3d"];
    const r = splitSpeechResults(
      [final("make me a maze game"), final("with penguins"), final("in 3d"), final("please")],
      0, // counter was reset by a successful restart
      committedTexts,
    );
    expect(r.freshFinalText).toBe("please");
  });

  it("a SINGLE repeated phrase is NOT deduped — a kid may genuinely say the same thing twice", () => {
    const r = splitSpeechResults([final("hello")], 0, ["make me a game", "hello"]);
    expect(r.freshFinalText).toBe("hello");
  });

  it("a genuinely fresh session's new words pass through untouched", () => {
    const r = splitSpeechResults([final("add a dragon")], 0, ["make me a maze game", "with penguins"]);
    expect(r.freshFinalText).toBe("add a dragon");
  });

  it("no committed texts (or omitted) → behavior identical to before", () => {
    const r = splitSpeechResults([final("I want"), final("a car")], 1);
    expect(r.freshFinalText).toBe("a car");
  });

  it("returns freshSegments so the caller can extend its committed-texts record", () => {
    const r = splitSpeechResults([final("one"), final("two")], 1, ["one"]);
    expect(r.freshSegments).toEqual(["two"]);
  });
});

describe("splitSpeechResults — Android duplicate-final artifact (take 4, 2026-07-19)", () => {
  // Pixel phone, Chrome AND Edge (both Chromium): in continuous mode Android
  // RE-APPENDS the same final to the results list on successive events —
  // [A], [A,A], [A,A,A]... Each duplicate sits past the committed counter as
  // a fresh single-segment slice, and the take-3 replay guard deliberately
  // lets single matches through (MIN_REPLAY_RUN=2) — so every duplicate
  // committed once more: "every 3 words captured 30 to 40 times".
  it("regression: the growing-duplicate event sequence commits the phrase exactly once", () => {
    const committedTexts: string[] = [];
    let count = 0;
    const commits: string[] = [];
    // Simulate the caller loop over three Android events.
    for (const results of [
      [final("make it a race")],
      [final("make it a race"), final("make it a race")],
      [final("make it a race"), final("make it a race"), final("make it a race")],
    ]) {
      const r = splitSpeechResults(results, count, committedTexts);
      count = r.finalCount;
      committedTexts.push(...r.freshSegments);
      if (r.freshFinalText) commits.push(r.freshFinalText);
    }
    expect(commits).toEqual(["make it a race"]);
  });

  it("a duplicate pair arriving in ONE event commits once", () => {
    const r = splitSpeechResults([final("add a pirate"), final("add a pirate")], 0, []);
    expect(r.freshSegments).toEqual(["add a pirate"]);
  });

  it("distinct consecutive finals are untouched", () => {
    const r = splitSpeechResults([final("add a pirate"), final("and a dragon")], 0, []);
    expect(r.freshSegments).toEqual(["add a pirate", "and a dragon"]);
  });

  it("a genuine repeat across a session RESTART still passes (fresh list has no predecessor)", () => {
    // Session 1 committed "hello"; session 2's fresh list starts with "hello"
    // again — a real kid repetition, not an adjacent-duplicate artifact.
    const r = splitSpeechResults([final("hello")], 0, ["hello"]);
    expect(r.freshFinalText).toBe("hello");
  });

  it("finalCount still counts dropped duplicates (slicing stays positional)", () => {
    const r = splitSpeechResults([final("go left"), final("go left")], 0, []);
    expect(r.finalCount).toBe(2);
  });

  // Production screenshot 2026-07-19 (Pixel): "I I want I want to I want to
  // I want to create..." — Android ALSO finalizes the same utterance again
  // as it GROWS, each snapshot a new list entry. A final that extends its
  // predecessor at a word boundary is the same utterance re-finalized —
  // commit only the newly-heard words (the delta).
  it("regression: growing cumulative snapshots commit each word exactly once", () => {
    const committedTexts: string[] = [];
    let count = 0;
    const commits: string[] = [];
    for (const results of [
      [final("I")],
      [final("I"), final("I want")],
      [final("I"), final("I want"), final("I want to")],
      [final("I"), final("I want"), final("I want to"), final("I want to")], // dup mixed in
      [final("I"), final("I want"), final("I want to"), final("I want to"), final("I want to create")],
    ]) {
      const r = splitSpeechResults(results, count, committedTexts);
      count = r.finalCount;
      committedTexts.push(...r.freshSegments);
      if (r.freshFinalText) commits.push(r.freshFinalText);
    }
    expect(commits.join(" ")).toBe("I want to create");
  });

  it("a grown snapshot arriving in the SAME event commits only the delta", () => {
    const r = splitSpeechResults([final("make it"), final("make it a race")], 0, []);
    expect(r.freshSegments).toEqual(["make it", "a race"]);
  });

  it("prefix without a word boundary is NOT treated as growth ('I want' vs 'I wanted')", () => {
    const r = splitSpeechResults([final("I want"), final("I wanted a car")], 0, []);
    expect(r.freshSegments).toEqual(["I want", "I wanted a car"]);
  });
});
