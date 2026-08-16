// Kid-facing filter for Gemini thought summaries (includeThoughts, 2026-07-11).
// A thought is MODEL OUTPUT shown to a child while the game is being planned —
// so this fails closed: only short, clean prose passes; anything code-like,
// markdown-fenced, or degenerate returns null and the UI keeps its last line.
// Pure logic, no React/Next.

export const KID_THOUGHT_MAX_CHARS = 120;
const MIN_CHARS = 8;

/** Characters that mean "this is code, not prose" — never show them to a kid. */
const CODE_LIKE = /[<>{}`;]|=>|\bconst\b|\blet\b|\bvar\b|\bfunction\b|\(\)/;

/**
 * Engineer's prose — clean English, no code characters, and still nothing a
 * child should be reading (2026-08-16, owner report from production):
 *
 *   "🛠️🏆 Pinpointing Draw Call Sources I'm now identifying the root cause of
 *    the draw calls."
 *
 * That is a debugging note about OUR renderer, shown to a child mid-play while
 * she waited for her game. CODE_LIKE could never catch it — there is no
 * punctuation to object to. The filter had only ever asked "is this code?",
 * never "is this about the child's game?", and the answer to the second
 * question is the one that matters on a surface a child reads.
 *
 * Fails closed by design: a rejected thought returns null and the UI keeps its
 * previous line, so the cost of over-matching is a slightly staler caption —
 * far cheaper than the cost of under-matching, which is this.
 */
const ENGINEER_JARGON =
  /\bdraw call|\broot cause|\brefactor|\binstanc(?:e|ing)\b|\bmesh(?:es)?\b|\bgeometr(?:y|ies)\b|\bshader|\bviewport|\bdebug|\bstack trace|\bnull\b|\bundefined\b|\bAPI\b|\bDOM\b|\bcanvas\b|\bframe ?rate|\bfps\b|\bmemory leak|\boptimi[sz]|\blatency|\bthrottl|\bregression|\bcodebase|\bpipeline\b|\bpayload\b|\bparse|\bsyntax|\bimport (?:map|statement)|\bWebGL|\bthree\.js|\bpatch\b|\bidentifying the\b/i;

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
    if (ENGINEER_JARGON.test(sentence)) continue;
    return truncate(sentence);
  }
  return null;
}
