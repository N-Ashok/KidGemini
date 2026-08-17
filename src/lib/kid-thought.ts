// Kid-facing filter for Gemini thought summaries (includeThoughts, 2026-07-11).
// A thought is MODEL OUTPUT shown to a child while the game is being planned —
// so this fails closed: only short, clean prose passes; anything code-like,
// markdown-fenced, or degenerate returns null and the UI keeps its last line.
// Pure logic, no React/Next.

export const KID_THOUGHT_MAX_CHARS = 120;
const MIN_CHARS = 8;

/** Characters that mean "this is code, not prose" — never show them to a kid. */
const CODE_LIKE = /[<>{}`;]|=>|\bconst\b|\blet\b|\bvar\b|\bfunction\b|\(\)/;

function truncate(sentence: string): string {
  if (sentence.length <= KID_THOUGHT_MAX_CHARS) return sentence;
  // Prefer a whole first clause; otherwise cut at a word and ellipsize.
  const clause = sentence.match(/^[^.!?]{8,}?[.!?]/)?.[0];
  if (clause && clause.length <= KID_THOUGHT_MAX_CHARS) return clause.trim();
  const cut = sentence.slice(0, KID_THOUGHT_MAX_CHARS - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

export function kidThoughtLine(raw: string): string | null {
  const prose = raw
    .replace(/```[\s\S]*?(```|$)/g, " ") // fenced blocks first, then leftover markers
    .replace(/[*_#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length < MIN_CHARS) return null;

  // Judge each sentence on its own (BUG-FIX-LOG 2026-08-01): a single
  // code-like sentence used to sink the WHOLE thought, even when a clean,
  // kid-safe sentence sat right next to it — exactly what edit-turn thinking
  // tends to produce (an exact code/function reference alongside a plain
  // planning line). The first sentence that passes wins; only a thought
  // where EVERY sentence is code-like/degenerate returns null.
  const sentences = prose.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  for (const sentence of sentences) {
    if (sentence.length < MIN_CHARS) continue;
    if (CODE_LIKE.test(sentence)) continue;
    return truncate(sentence);
  }
  return null;
}
