// Pure parsing of a SpeechRecognition result event (used by useSpeechInput).
// Split so the loss-prevention logic is unit-testable in node.
//
// Contract: `freshFinalText` is committed immediately; `interimText` is the
// recognized-but-not-final tail the CALLER must flush if the session ends
// before it finalizes (browsers hard-end sessions mid-speech and discard it).

export interface SpeechResultSplit {
  /** Newly finalized speech (from resultIndex onward) — commit now. */
  freshFinalText: string;
  /** Recognized but not yet final — replaces any previous interim tail. */
  interimText: string;
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
  resultIndex: number | undefined,
): SpeechResultSplit {
  const all = Array.from(results);
  const text = (rs: SpeechResultLike[]) =>
    rs
      .map((r) => r[0]?.transcript ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
  return {
    freshFinalText: text(all.slice(resultIndex ?? 0).filter((r) => r.isFinal === true)),
    // Interims always sit at the session tail — rebuild from the WHOLE list so
    // a segment that just finalized drops out of the interim buffer (no doubles).
    interimText: text(all.filter((r) => r.isFinal !== true)),
  };
}
