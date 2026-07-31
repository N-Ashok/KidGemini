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
const KEYWORD_EMOJI: Array<[RegExp, string]> = [
  [/dinosaur/i, "🦖"],
  [/field|arena|stadium/i, "🏟️"],
  [/swing|\bbat\b/i, "🏏"],
  [/sound|audio|music/i, "🔊"],
  [/score|point/i, "🏆"],
  [/jump|hop/i, "🦘"],
  [/color|paint/i, "🎨"],
  [/ball/i, "⚾"],
  [/\bsky\b|background/i, "☁️"],
  [/character|player/i, "🧍"],
  [/enemy|monster/i, "👾"],
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
  const { emoji } = buildStepLabel(input.askText);
  const preview =
    input.askText.length > ASK_PREVIEW_MAX_CHARS
      ? `${input.askText.slice(0, ASK_PREVIEW_MAX_CHARS)}…`
      : input.askText;
  return `${emoji} Making "${preview}" — you can keep playing this one! ✨`;
}
