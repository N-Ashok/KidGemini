// Patch-based feature edits (BUG-FIX-LOG class fix, 2026-07-18): a follow-up
// request on an already-good game ("add a medic kit") was being answered by
// regenerating the ENTIRE file from context, which regresses parts the child
// never asked to change — a known LLM weak spot even under "keep the rest
// the same" framing. Reuses the SEARCH/REPLACE minimal-patch contract that
// already exists for self-healing repairs (repair-prompt.ts's
// REPAIR_SYSTEM_PROMPT / applyPatch()), applied here to feature requests
// instead of bug fixes.

import { isGameBuildTurn } from "./builder-mode";
import type { ChatMessage } from "@/types/chat.types";

// Deliberately NOT importing from gemini.ts or history-trim.ts here: gemini.ts
// needs GAME_EDIT_PROMPT_SECTION (below), and history-trim.ts imports from
// gemini.ts — either import would create a 3-way module cycle
// (gemini.ts -> game-edit.ts -> history-trim.ts -> gemini.ts). Instead this
// uses the SAME already-populated `artifactHtml` field isGameBuildTurn checks
// (real assistant messages always carry it — see route.ts's
// `send({ type:"done", text, artifactHtml })`), which also keeps
// isGameEditTurn/currentGameHtml internally consistent with isGameBuildTurn's
// own signal rather than mixing it with history-trim's separate
// text-re-derivation rule (used there for a different purpose — stripping
// stale prose, not locating the current source).
function lastGameIndex(history: ChatMessage[]): number {
  return history.reduce((acc, m, i) => (m.role === "assistant" && Boolean(m.artifactHtml) ? i : acc), -1);
}

/** True when this turn should edit the EXISTING game via a patch, rather than
 *  build fresh: a game-shaped ask (isGameBuildTurn) AND a game already
 *  exists in history to edit. False on a first-ever build (nothing to patch
 *  against yet).
 *
 *  Deliberately as over-inclusive as isGameBuildTurn itself once a game
 *  exists (same "make the player jump higher never says game" tradeoff,
 *  builder-mode.ts) — there's no reliable keyword rule that tells a game
 *  tweak apart from unrelated chat mid-conversation. Robustness against a
 *  genuinely off-topic message isn't this function's job: GAME_EDIT_PROMPT_SECTION
 *  is hedged to just answer normally when the message isn't about the game,
 *  and the route treats that plain-prose reply as ordinary chat rather than
 *  forcing a wasted regeneration (api/chat/route.ts). */
export function isGameEditTurn(message: string, history: ChatMessage[]): boolean {
  return isGameBuildTurn(message, history) && lastGameIndex(history) !== -1;
}

/** The current game's full source (the newest one), or undefined if none
 *  exists yet. */
export function currentGameHtml(history: ChatMessage[]): string | undefined {
  const idx = lastGameIndex(history);
  return idx === -1 ? undefined : history[idx]!.artifactHtml;
}

const DEFAULT_EDIT_LINE = "Added that! 🎮";

/** Splits the model's edit-turn reply into its kid-facing sentence (never
 *  shown: the raw SEARCH/REPLACE hunks). The full, unsplit reply still goes
 *  to applyPatch() unchanged — its regex scans for patch blocks anywhere in
 *  the text, so this split only affects what's DISPLAYED in the chat. */
export function editReplyProse(reply: string): string {
  const prose = reply.split(/<{7} SEARCH/)[0]!.trim();
  return prose || DEFAULT_EDIT_LINE;
}

/** Appended to CHILD_SYSTEM_PROMPT (same pattern as THREE_PROMPT_SECTION /
 *  MULTIPLAYER_PROMPT_SECTION in gemini.ts's buildTurnSystemInstruction) so
 *  every existing safety/gameplay/responsiveness rule still applies to
 *  whatever the edit adds — unlike a repair, a feature edit can introduce
 *  new visible content the safety rules must still govern. Modeled on
 *  repair-prompt.ts's already-proven REPAIR_SYSTEM_PROMPT wording. */
export const GAME_EDIT_PROMPT_SECTION = `The child already has a working game from this conversation. If this message is actually asking you to change or add something to it, this is NOT a fresh build — do not rewrite the whole file. If the message isn't about the game at all (a question, plain chat), ignore everything below and just answer normally instead.
First, on its own line, write ONE short, encouraging sentence about what you added (no code, no markdown fence).
Then return the change as one or more blocks in EXACTLY this format, and nothing else after that sentence:
<<<<<<< SEARCH
(lines copied EXACTLY, character for character, from the current source)
=======
(the replacement lines, including the new feature)
>>>>>>> REPLACE
Rules:
- The SEARCH text must match the current source exactly and uniquely.
- Change only what this request needs. Do not rename, restyle, reformat, or "improve" anything else — the child is proud of the game exactly as it plays right now.
- Everything you don't put in a REPLACE block must stay byte-for-byte identical.
- No prose after the patch blocks, no markdown fences, no full HTML document.`;
