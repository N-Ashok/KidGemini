// Kid-facing filter for Gemini thought summaries (includeThoughts, 2026-07-11).
// A thought is MODEL OUTPUT shown to a child while the game is being planned —
// so this fails closed: only short, clean prose passes; anything code-like,
// markdown-fenced, or degenerate returns null and the UI keeps its last line.
// Pure logic, no React/Next.

export const KID_THOUGHT_MAX_CHARS = 120;
const MIN_CHARS = 8;

/** Characters that mean "this is code, not prose" — never show them to a kid. */
const CODE_LIKE = /[<>{}`;]|=>|\bconst\b|\blet\b|\bvar\b|\bfunction\b|\(\)/;

export function kidThoughtLine(raw: string): string | null {
  const prose = raw
    .replace(/```[\s\S]*?(```|$)/g, " ") // fenced blocks first, then leftover markers
    .replace(/[*_#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length < MIN_CHARS) return null;
  if (CODE_LIKE.test(prose)) return null;

  if (prose.length <= KID_THOUGHT_MAX_CHARS) return prose;
  // Prefer a whole first sentence; otherwise cut at a word and ellipsize.
  const sentence = prose.match(/^[^.!?]{8,}?[.!?]/)?.[0];
  if (sentence && sentence.length <= KID_THOUGHT_MAX_CHARS) return sentence.trim();
  const cut = prose.slice(0, KID_THOUGHT_MAX_CHARS - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}
