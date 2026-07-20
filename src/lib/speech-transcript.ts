// Pure parsing of a SpeechRecognition result event (used by useSpeechInput).
// Split so the loss-prevention logic is unit-testable in node.
//
// Contract: `freshFinalText` is committed immediately; `interimText` is the
// recognized-but-not-final tail the CALLER must flush if the session ends
// before it finalizes (browsers hard-end sessions mid-speech and discard it).
//
// Repeat-mic bug (2026-07-14): this used to slice by `event.resultIndex` — the
// browser's own claim about which results are "new since last event." That
// field is unreliable on some browsers/webviews (observed stuck at/near 0
// across events). When it doesn't advance, every newly-finalized segment made
// `freshFinalText` recompute from the START of the session instead of just
// the new bit, so the caller re-appended the WHOLE transcript-so-far on every
// final — "I want" → "I want I want" → "I want I want I want a car" ..., each
// new final segment compounding the repeat (matches both the 3x-on-a-short-
// phrase and 30-40x-on-a-long-monologue reports — the count tracks how many
// final segments the session produced). Fix: don't trust resultIndex at all —
// the CALLER tracks how many finals it has already committed (`finalCount`,
// returned below) and passes that count back in, so "what's fresh" is
// self-derived from our own bookkeeping, not a browser-supplied index.

/**
 * After an attempted (re)start of the recognizer, what should the caller's
 * committed-finals counter become?
 *
 * Repeat-mic regression, take 2 (2026-07-16): the original 2026-07-14 fix
 * (below) assumed "a new session gets a fresh browser results list" and
 * reset the counter to 0 at every `rec.start()` call — but `start()` can
 * THROW ("already started") when the browser hasn't actually torn down the
 * PREVIOUS session yet (a documented Chrome timing quirk; the restart delay
 * is a best-effort gap, not a guarantee). When that happens the old session
 * — with its already-accumulated finals — keeps feeding `onresult`, so
 * zeroing the counter anyway makes the next event replay everything already
 * committed: the exact "I want" → "I want I want I want" shape, via a
 * restart race instead of a resultIndex lie. Only a session that ACTUALLY
 * (re)started gets a fresh counter; a failed start means the old session
 * (and its old count) is still the one running.
 */
export function committedCountAfterRestart(
  startSucceeded: boolean,
  previousCount: number,
): number {
  return startSucceeded ? 0 : previousCount;
}

export interface SpeechResultSplit {
  /** Newly finalized speech beyond what the caller already committed — commit now. */
  freshFinalText: string;
  /** The same fresh finals as individual segments — append to the caller's
   *  committed-texts record (the take-3 replay guard below). */
  freshSegments: string[];
  /** Recognized but not yet final — replaces any previous interim tail. */
  interimText: string;
  /** Total finalized segments seen this session — pass back in as `alreadyCommitted`
   *  on the next call so already-committed finals are never re-emitted. */
  finalCount: number;
}

type SpeechResultLike = ArrayLike<{ transcript: string }> & { isFinal?: boolean };

/**
 * What the composer DISPLAYS while dictating: committed text + the live
 * interim tail. The interim is visual only — it's committed by the hook when
 * it finalizes (or when the session ends), never by the display layer.
 */
export function composeDictation(committed: string, interim: string): string {
  if (!interim) return committed;
  return committed ? `${committed} ${interim}` : interim;
}

/** Replay guard, take 3 (2026-07-18, found by e2e-mic-dictation.mjs): the
 *  count-based accounting can't tell a fresh session's NEW list from a
 *  lingering OLD session's stale list. After a SUCCESSFUL restart the counter
 *  legitimately resets to 0 — if the old session then resurfaces (a restart
 *  race later in the same listen), its cumulative finals all sit "past" the
 *  zeroed counter and re-commit: the "I want I want" flood via a third path.
 *  Texts don't lie where counters can: two or more consecutive
 *  already-committed finals reappearing at the HEAD of the fresh slice are a
 *  replay, not new speech, and are dropped. A single match is deliberately
 *  let through — a kid may genuinely say the same phrase twice. */
const MIN_REPLAY_RUN = 2;

function dropReplayedPrefix(fresh: string[], committedTexts: string[]): string[] {
  const max = Math.min(fresh.length, committedTexts.length);
  for (let k = max; k >= MIN_REPLAY_RUN; k--) {
    const tail = committedTexts.slice(committedTexts.length - k);
    if (tail.every((t, i) => t === fresh[i])) return fresh.slice(k);
  }
  return fresh;
}

/** Replay guard, take 4 (2026-07-19, owner UAT on a Pixel — Chrome AND Edge,
 *  both Chromium). Android's recognizer in continuous mode re-finalizes the
 *  SAME utterance as new list entries, in two shapes (both seen live):
 *   1. re-appended verbatim — [A], [A,A], [A,A,A]…
 *   2. re-finalized as it GROWS — ["I"], ["I","I want"], ["I","I want",
 *      "I want to"]… (production screenshot: "I I want I want to I want to
 *      create…")
 *  Each new entry sits past the committed counter as a fresh single-segment
 *  slice, and take 3's MIN_REPLAY_RUN=2 deliberately lets single matches
 *  through — so every re-finalization committed again ("every 3 words
 *  captured 30-40 times"). Identity from content, at the source: within ONE
 *  session's list, a final identical to its predecessor is dropped, and a
 *  final that extends its predecessor at a word boundary is the same
 *  utterance re-heard — only the NEW words (the delta) commit. A kid saying
 *  "go go" arrives as one final, and a genuine repeat across a silence
 *  restart starts a FRESH list whose first final has no predecessor, so the
 *  take-3 single-repeat allowance still stands (pinned by test). */
function effectiveFreshFinals(finalTexts: string[], from: number): string[] {
  // Positional: finalTexts is index-aligned with the session's finals list
  // (empties NOT yet filtered), so the predecessor check works across the
  // committed/fresh boundary too.
  const out: string[] = [];
  for (let i = from; i < finalTexts.length; i++) {
    const text = finalTexts[i]!;
    const prev = i > 0 ? finalTexts[i - 1]! : undefined;
    if (!text) continue;
    if (prev !== undefined && text === prev) continue; // shape 1: verbatim duplicate
    if (prev && text.startsWith(`${prev} `)) {
      out.push(text.slice(prev.length + 1)); // shape 2: grown snapshot → delta only
      continue;
    }
    out.push(text);
  }
  return out;
}

export function splitSpeechResults(
  results: ArrayLike<SpeechResultLike>,
  alreadyCommitted: number | undefined,
  committedTexts: string[] = [],
): SpeechResultSplit {
  const all = Array.from(results);
  const segments = (rs: SpeechResultLike[]) =>
    rs.map((r) => r[0]?.transcript?.trim() ?? "").filter(Boolean);
  const finals = all.filter((r) => r.isFinal === true);
  // Sliced by OUR OWN running count, not the browser's resultIndex (see the
  // 2026-07-14 note); Android re-finalization artifacts collapsed to their
  // new words (take 4 above); then replay-guarded by committed TEXTS (take 3).
  const freshSegments = dropReplayedPrefix(
    effectiveFreshFinals(
      finals.map((r) => r[0]?.transcript?.trim() ?? ""),
      alreadyCommitted ?? 0,
    ),
    committedTexts,
  );
  return {
    freshFinalText: freshSegments.join(" ").trim(),
    freshSegments,
    // Interims always sit at the session tail — rebuild from the WHOLE list so
    // a segment that just finalized drops out of the interim buffer (no doubles).
    interimText: segments(all.filter((r) => r.isFinal !== true)).join(" ").trim(),
    finalCount: finals.length,
  };
}
