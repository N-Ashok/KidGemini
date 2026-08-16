// Keyword→emoji labeling over an already kid-safe thought line
// (docs/2026-07-31_PRD_BuildProgressNarration.md). Runs AFTER
// kidThoughtLine() has filtered the raw model thought — this never
// re-validates safety, it only tags the live signal with an emoji so a build
// step reads as "🦖 adding the dinosaur" instead of a generic caption, while
// the kid is still playing the current game. Pure, framework-free.

export interface BuildStepLabel {
  emoji: string;
  text: string;
}

/** First match wins — order is the tie-break when a line mentions more than one. */
// WORD BOUNDARIES ARE NOT OPTIONAL (2026-08-16). Owner, from production:
// "🛠️🏆 Pinpointing Draw Call Sources…" — the trophy came from /point/ matching
// inside "Pinpointing". Unanchored fragments also gave 🦘 for "shopping",
// ⚾ for "football" and 🎨 for "colorful"; every one of them mislabels what the
// child is watching being built.
const KEYWORD_EMOJI: Array<[RegExp, string]> = [
  [/\bdinosaurs?\b/i, "🦖"],
  [/\b(?:field|arena|stadium)s?\b/i, "🏟️"],
  [/\b(?:swing|bat)s?\b/i, "🏏"],
  [/\b(?:sound|audio|music)s?\b/i, "🔊"],
  [/\b(?:score|point)s?\b/i, "🏆"],
  [/\b(?:jump|hop)(?:s|ing)?\b/i, "🦘"],
  [/\b(?:colou?r|paint)(?:s|ing|ed|ful)?\b/i, "🎨"],
  [/\bballs?\b/i, "⚾"],
  [/\b(?:sky|background)s?\b/i, "☁️"],
  [/\b(?:character|player)s?\b/i, "🧍"],
  [/\b(?:enemy|enemies|monsters?)\b/i, "👾"],
];

const GENERIC_EMOJI = "🛠️";

export function buildStepLabel(thoughtLine: string): BuildStepLabel {
  const match = KEYWORD_EMOJI.find(([pattern]) => pattern.test(thoughtLine));
  return { emoji: match ? match[1] : GENERIC_EMOJI, text: thoughtLine };
}

const ASK_PREVIEW_MAX_CHARS = 48;

/** The preview strip's line while a build streams. A live thought line (real
 *  model signal) always wins; small edits often produce nothing that passes
 *  kidThoughtLine()'s safety filter, so the kid's OWN request — already past
 *  the input gate, always available — is the guaranteed fallback instead of a
 *  generic caption with no derived emoji at all (BUG-FIX-LOG 2026-07-31). */
export function buildUpdatingLine(input: {
  thinkingLine: string | null;
  askText: string | null;
}): string | undefined {
  if (input.thinkingLine) {
    const { emoji, text } = buildStepLabel(input.thinkingLine);
    return `${emoji} ${text}`;
  }
  if (!input.askText) return undefined;
  // A LONG ask is not quotable (2026-08-16). Owner, from production:
  //
  //   🛠️🛠️ Making "The game is good only issue is that the humans a…"
  //
  // The fallback quotes the child's own words, which reads well for a short
  // instruction ("add buildings and grass") and badly for a sentence ABOUT the
  // game — chopped mid-word, it announces that we are building her complaint.
  // Below the budget, quote her. Above it, say nothing here and let the caller
  // use its plain "Making your update…" line, which is always true.
  if (input.askText.length > ASK_PREVIEW_MAX_CHARS) return undefined;
  const { emoji } = buildStepLabel(input.askText);
  return `${emoji} Making "${input.askText}" — you can keep playing this one! ✨`;
}
