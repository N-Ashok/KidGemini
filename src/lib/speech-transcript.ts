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

export interface SpeechResultSplit {
  /** Newly finalized speech beyond what the caller already committed — commit now. */
  freshFinalText: string;
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

export function splitSpeechResults(
  results: ArrayLike<SpeechResultLike>,
  alreadyCommitted: number | undefined,
): SpeechResultSplit {
  const all = Array.from(results);
  const text = (rs: SpeechResultLike[]) =>
    rs
      .map((r) => r[0]?.transcript ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
  const finals = all.filter((r) => r.isFinal === true);
  return {
    // Sliced by OUR OWN running count, not the browser's resultIndex — see
    // the 2026-07-14 note above for why the browser's index can't be trusted.
    freshFinalText: text(finals.slice(alreadyCommitted ?? 0)),
    // Interims always sit at the session tail — rebuild from the WHOLE list so
    // a segment that just finalized drops out of the interim buffer (no doubles).
    interimText: text(all.filter((r) => r.isFinal !== true)),
    finalCount: finals.length,
  };
}
