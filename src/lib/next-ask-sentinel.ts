// Model-generated next-ask suggestions (2026-07-28, PRD
// Game/docs/2026-07-27_PRD_KidHintsAndNextBestAsk.md). Piggybacks on the
// EXISTING chat-turn call instead of a static pool or a second API call —
// Gemini already knows exactly what game it just built, so this line is
// near-zero added cost (a few output tokens on a call already happening),
// same "bare sentinel line, parsed and stripped server-side before the kid
// ever sees it" convention already used by NEW_GAME_SENTINEL (game-edit.ts).
//
// FRESH-BUILD TURNS ONLY (route.ts / gemini.ts wire this up that way): the
// edit/patch pipeline (GAME_EDIT_PROMPT_SECTION, game-edit.ts) has a strict
// "nothing after the patch blocks" contract enforced by applyPatch()'s exact
// SEARCH/REPLACE parsing — bolting a trailing sentinel onto that risks
// destabilizing a pipeline with a long history of subtle regressions. Edit
// turns always fall back to next-ask-hints.ts's static pool instead.

export const NEXT_ASKS_PREFIX = "NEXT_ASKS:";

/** Appended to the system instruction ONLY on fresh-build (non-edit) turns,
 *  gated behind kidHintsEnabled() at the call site (gemini.ts's configFor) so
 *  there is exactly zero added cost when the feature flag is off. */
export const NEXT_ASK_PROMPT_SECTION = `After the \`\`\`html code block closes, on its own new line, add exactly one more line in this exact format and nothing else after it:
${NEXT_ASKS_PREFIX} <idea one> | <idea two> | <idea three>
Each idea is a SHORT (under 12 words) suggestion for what the child could try next, written as something THEY would say to you, not a description of it. Two ideas should be concrete, buildable features about the game you just built. The third should be a fun, open-ended "what if" idea about the game's theme, story or world — something that sparks imagination, not another mechanical feature. Never mention this line, or that you were asked for it, anywhere else in your reply.`;

const MAX_IDEA_LENGTH = 80;

export interface ParsedNextAsk {
  ideas: string[];
  /** `text` with the sentinel line removed and re-trimmed — always use this,
   *  never the original, so the raw sentinel can never leak to the kid even
   *  when parsing succeeds. */
  cleanedText: string;
}

/** Parses a trailing `NEXT_ASKS: a | b | c` line out of `text` (the model's
 *  PROSE only — callers must pass extractArtifact's `text`, never raw HTML,
 *  so a coincidental match inside generated game code can't be misparsed).
 *  Fails toward `null` (not throwing) on anything malformed — bad model
 *  output must never crash the response pipeline; the caller falls back to
 *  the static pool (next-ask-hints.ts) instead. */
export function parseNextAskLine(text: string): ParsedNextAsk | null {
  const trimmed = text.trimEnd();
  if (!trimmed) return null;
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1]!.trim();
  if (!lastLine.startsWith(NEXT_ASKS_PREFIX)) return null;

  const raw = lastLine.slice(NEXT_ASKS_PREFIX.length).trim();
  const ideas = raw.split("|").map((s) => s.trim());
  if (ideas.length !== 3) return null;
  if (ideas.some((idea) => idea.length === 0 || idea.length > MAX_IDEA_LENGTH)) return null;
  // Defensive — rejects anything that looks like it broke out of plain text
  // (a stray tag, backtick/code fence, or markdown table pipe artifact).
  if (ideas.some((idea) => /[<>`]/.test(idea))) return null;

  const cleanedText = lines.slice(0, -1).join("\n").trim();
  return { ideas, cleanedText };
}

/** Hides a NEXT_ASKS line while it's still streaming in, token by token.
 *  Without this, the raw sentinel (ideas separated by pipes) flashes live in
 *  the chat bubble for the second or two it takes to stream in, before the
 *  `done` event swaps in the already-cleaned text (route.ts) — a real bug
 *  confirmed live during manual testing. Mirrors game-edit.ts's
 *  streamingDisplayText treatment of NEW_GAME_SENTINEL: hides the trailing
 *  line whenever it's still a plausible PREFIX of the sentinel token (however
 *  partial — "N", "NEXT_A", …) or has grown into a full sentinel line, and
 *  leaves everything else untouched. Safe to call unconditionally (flag off
 *  ⇒ the model never emits this line ⇒ this is a no-op almost always). */
export function hidePartialNextAskLine(text: string): string {
  const idx = text.lastIndexOf("\n");
  const lastLine = (idx === -1 ? text : text.slice(idx + 1)).trim();
  if (!lastLine) return text;
  const isPrefixOfSentinel = NEXT_ASKS_PREFIX.startsWith(lastLine);
  const isSentinelLine = lastLine.startsWith(NEXT_ASKS_PREFIX);
  if (!isPrefixOfSentinel && !isSentinelLine) return text;
  return idx === -1 ? "" : text.slice(0, idx).trimEnd();
}
