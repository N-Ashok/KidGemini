// Deterministic file-open (BUG-FIX-LOG 2026-07-26): a kid uploads their game's
// HTML and says "open the file" — that turn must NEVER reach the model. The
// old (only) path folded the file into the prompt, so Gemini regenerated its
// own version of the game and "opening" meant hallucinated additions. Now a
// complete HTML document opens in the preview byte-for-byte, with no model
// call; the model is involved only when the kid actually asks for a change —
// and then as an ordinary patch-edit against the opened game. Pure module,
// fully unit-tested; ChatPanel.container executes the plan it returns.

/** Same document detection extractArtifact uses for unfenced model replies:
 *  a real document opens in the preview; fragments/scripts can't render. */
export function isCompleteHtmlDocument(content: string): boolean {
  return /<!doctype html|<html[\s>]/i.test(content);
}

// "Open it"-type verbs. `see` covers "let me see the game".
const OPEN_VERBS = new Set(["open", "show", "load", "run", "play", "start", "preview", "see"]);
// Words that can dress an open request without changing its meaning. Anything
// OUTSIDE this set means the kid asked for something real → model edit turn.
const FILLER = new Set([
  "please", "can", "could", "you", "me", "let", "us",
  "the", "my", "this", "that", "it", "a", "an",
  "file", "game", "code", "html", "up", "now", "and", "then",
]);

/** True when the message asks ONLY to open/see the upload (or says nothing).
 *  Conservative on purpose: "open a shop in the game" contains 'open' but the
 *  non-filler 'shop' makes it an edit request, not an open request. */
export function isOpenOnlyRequest(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  let sawVerb = false;
  for (const w of words) {
    if (OPEN_VERBS.has(w)) { sawVerb = true; continue; }
    if (!FILLER.has(w)) return false;
  }
  return sawVerb;
}

export type FileOpenPlan =
  | { mode: "model" } // today's behavior: file folds into the prompt
  | { mode: "open-only"; html: string } // open in preview, NO model call
  | { mode: "open-then-edit"; html: string }; // open first, then edit the opened game

/** Decide what an upload turn does. Only complete HTML documents ever open
 *  directly — every other attachment keeps the existing model path. */
export function fileOpenPlan(
  attachment: { kind: string; content?: string } | undefined,
  text: string,
): FileOpenPlan {
  if (attachment?.kind !== "text" || !attachment.content || !isCompleteHtmlDocument(attachment.content)) {
    return { mode: "model" };
  }
  return isOpenOnlyRequest(text)
    ? { mode: "open-only", html: attachment.content }
    : { mode: "open-then-edit", html: attachment.content };
}

/** The local (never-from-the-model) assistant line shown with the opened game. */
export function openedFileLine(name: string): string {
  return `📂 I opened "${name}" — it's playing in the preview! Tell me what you'd like to change.`;
}

/** What the API history shows as the kid's upload turn on an open-then-edit.
 *  Deliberately NOT the kid's typed text: the typed text rides as the final
 *  user message, and an identical copy one slot earlier would trip the
 *  server's isRepeatedRequest ("exact re-send of the last message"). */
export function uploadHistoryLine(name: string): string {
  return `I uploaded my game file "${name}".`;
}
