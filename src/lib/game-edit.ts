// Patch-based feature edits (BUG-FIX-LOG class fix, 2026-07-18): a follow-up
// request on an already-good game ("add a medic kit") was being answered by
// regenerating the ENTIRE file from context, which regresses parts the child
// never asked to change — a known LLM weak spot even under "keep the rest
// the same" framing. Reuses the SEARCH/REPLACE minimal-patch contract that
// already exists for self-healing repairs (repair-prompt.ts's
// REPAIR_SYSTEM_PROMPT / applyPatch()), applied here to feature requests
// instead of bug fixes.

import { isGameBuildTurn } from "./builder-mode";
import { arAssetsKeys, assetMarkerNames, hasAssetMarker, looksInjected, stripAssetMarkers } from "./assets/markers";
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
// `pinnedId` (chat-rewind.ts's "Continue from here") overrides recency, same
// rule as history-trim.ts's findLastGameIndex — kept as a separate lookup
// rather than a shared one for the reason explained above (the module-cycle
// + text-vs-field signal mismatch), but the override behaves identically:
// when set and it names a real game message, that one wins over anything
// newer.
function lastGameIndex(history: ChatMessage[], pinnedId?: string): number {
  if (pinnedId) {
    const pinned = history.findIndex((m) => m.id === pinnedId && m.role === "assistant" && Boolean(m.artifactHtml));
    if (pinned !== -1) return pinned;
  }
  return history.reduce((acc, m, i) => (m.role === "assistant" && Boolean(m.artifactHtml) ? i : acc), -1);
}

/** Kill switch (penguin-maze hardening, 2026-07-18): GAME_EDIT_PATCH=off
 *  restores exact pre-patch behavior — every follow-up regenerates in full,
 *  as before faab905 — with one env flip and a restart, no git surgery.
 *  Checked inside isGameEditTurn so this single choke point disables both
 *  call sites at once (the route's edit branch and gemini.ts's configFor
 *  prompt section). Any value other than "off" (including unset) = enabled. */
export function patchEditsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GAME_EDIT_PATCH !== "off";
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
export function isGameEditTurn(message: string, history: ChatMessage[], pinnedId?: string): boolean {
  return patchEditsEnabled() && isGameBuildTurn(message, history) && lastGameIndex(history, pinnedId) !== -1;
}

/** True when the child sent the SAME message again (whitespace/case
 *  normalized) as their previous one. Penguin-maze session 2026-07-18: the
 *  identical request was pasted three times because each reply claimed
 *  success without the change appearing on screen — a repeat is a failure
 *  signal, and the model must be told instead of re-claiming success. */
export function isRepeatedRequest(message: string, history: ChatMessage[]): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const current = norm(message);
  if (!current) return false;
  const lastChild = [...history].reverse().find((m) => m.role === "child");
  return Boolean(lastChild) && norm(lastChild!.text) === current;
}

/** The current game's full source — the newest one, or the pinned one
 *  ("Continue from here") when a pin is active — or undefined if none
 *  exists yet. */
export function currentGameHtml(history: ChatMessage[], pinnedId?: string): string | undefined {
  const idx = lastGameIndex(history, pinnedId);
  return idx === -1 ? undefined : history[idx]!.artifactHtml;
}

/** True when text carries any visible trace of an attempted code/patch edit
 *  (patch markers, a markdown code fence, or HTML/script tags) — tells a
 *  genuinely off-topic reply (safe to show as plain chat) apart from a
 *  malformed/truncated edit attempt (unsafe to show raw; must fall back to a
 *  full regeneration instead of dumping it in the chat bubble). BUG-FIX-LOG
 *  2026-07-18 follow-up: a garbled SEARCH/REPLACE attempt applyPatch()
 *  couldn't parse at all was landing in "no patch found" and being shown to
 *  the child as literal raw text — "multiple blocks and not working code." */
export function looksLikeAttemptedEdit(reply: string): boolean {
  return /<{3,}|>{3,}|=======|```|<html[\s>]|<!doctype html|<script[\s>]/i.test(reply);
}

/** True when html looks like a genuinely complete document (has both an
 *  opening and closing <html> tag). Guards applyPatch()'s "regeneration"
 *  fallback mode (the model ignored the patch instruction and wrote a
 *  fenced/raw block instead): a PARTIAL snippet or "here's what changed"
 *  explanation would otherwise be silently trusted as the WHOLE game,
 *  replacing it with a broken fragment. */
export function looksLikeCompleteDocument(html: string): boolean {
  return /<html[\s>]/i.test(html) && /<\/html>/i.test(html);
}

/** A document that STARTED but never finished — an opening `<html` with no
 *  closing `</html>`. This is the fingerprint of a truncated build: the model
 *  returned `finishReason: STOP` ("done") on a half-written game (BUG-FIX-LOG
 *  2026-07-22, "30 New Testament characters" stopped ~5K chars three times).
 *  Deliberately NARROWER than `!looksLikeCompleteDocument`: a game with no
 *  `<html>` tag at all (a bare fragment) is NOT flagged — only a document that
 *  clearly began and was cut off — so the completeness guard never false-fires
 *  on a legitimately-fragment game. */
export function looksTruncatedDocument(html: string): boolean {
  return /<html[\s>]/i.test(html) && !/<\/html>/i.test(html);
}

/**
 * The one KNOWN, provable cause of `inSource=false` on edit turns
 * (BUG-FIX-LOG 2026-07-20, KNOWN_BUGS #5): injectAssets STRIPS the
 * `<!--USES_MODELS: …-->` / `<!--USES_THREE-->` / `<!--USES_AUDIO: …-->`
 * markers out of a delivered asset game (they become an import map + AR_ASSETS
 * table). The model, told by the 3D/asset prompt sections to always emit those
 * markers, re-writes them into its SEARCH block — which then can't be found in
 * the marker-stripped stored source, so the patch fails and the turn escalates
 * to a full, destructive regeneration.
 *
 * When a patch fails to apply, this returns a marker-free copy of the reply to
 * re-run applyPatch against — reconciling the markers out of SEARCH exactly as
 * injection removed them from the source, so a body-anchored edit ("make the
 * car faster") matches again. Returns null (leave the regeneration path alone)
 * whenever reconciliation could regress anything:
 *
 *   · the reply carries no marker (nothing to reconcile), or
 *   · the current game was never injected (a marker in the reply is then a
 *     genuine NEW asset request, not a re-statement), or
 *   · a marker names an asset the game doesn't already reference (a real add
 *     that needs full re-injection — regeneration handles it correctly).
 *
 * Pure — no I/O. Deliberately conservative: it can only ever turn a failed
 * patch into a working one, never change a patch that already applied.
 */
export function reconcileAssetMarkers(currentHtml: string, reply: string): string | null {
  if (!hasAssetMarker(reply)) return null;
  if (!looksInjected(currentHtml)) return null;
  const present = new Set(arAssetsKeys(currentHtml));
  if (assetMarkerNames(reply).some((name) => !present.has(name))) return null;
  return stripAssetMarkers(reply);
}

/** The model's self-declaration that the child asked for a genuinely DIFFERENT
 *  game, not a change to the current one (PRD-RESILIENT-GENERATION §11). Emitted
 *  ALONE on its own line when the new-game clause of GAME_EDIT_PROMPT_SECTION
 *  fires — deliberately an ugly, unambiguous token no child would type. */
export const NEW_GAME_SENTINEL = "NEW_GAME_REQUEST";

/** Kid-facing question shown when a new-game request is detected. Says nothing
 *  is lost either way (PRD §11 risk table) so the child never fears the choice. */
export const NEW_GAME_PROMPT_LINE =
  "That sounds like a whole new game! 🎮 Want to start it in a fresh chat, so this game stays exactly how you like it? Nothing gets lost either way.";

/**
 * True when the model self-declared a NEW-GAME request (PRD §11). Fail toward
 * NOT asking: the sentinel must stand alone on its own line AND the reply must
 * carry no real work — a patch (SEARCH markers) or a full game document means
 * the model actually did the edit/rebuild, so honor THAT over an incidental
 * sentinel. The prompt only fires on a high-confidence, self-declared, no-work
 * reply — never mid-flow on a child who was really just editing.
 */
export function detectsNewGame(reply: string): boolean {
  const trimmed = reply.trim();
  if (!trimmed) return false;
  if (!new RegExp(`(^|\\n)\\s*${NEW_GAME_SENTINEL}\\s*(\\n|$)`).test(trimmed)) return false;
  if (/<{7} SEARCH/.test(reply)) return false; // it actually patched — that's an edit
  if (/<!doctype html|<html[\s>]/i.test(reply)) return false; // it actually built a game
  return true;
}

const DEFAULT_EDIT_LINE = "Added that! 🎮";

/** The generic done-line for a FRESH build (extractArtifact's default when
 *  the model returned only code). Lives here so the route can recognize it:
 *  on a turn that REPLACED an existing game it must never be shown — it
 *  reads as "small change done" when the whole game was rebuilt. */
export const FRESH_GAME_LINE = "Here's your game! 🎮";

/** Honest kid-facing line whenever an edit turn ended in a whole-game
 *  rebuild (accepted regeneration or the forceFullRegen fallback) and the
 *  model left no usable prose. Penguin-maze hardening 2026-07-18: bare
 *  success lines ("Added that!", "Here's your game!") on rebuilds hid real
 *  regressions — colors changed, controls flipped — and the child had no
 *  idea why. Saying a rebuild happened invites the bug report instead. */
export const REBUILT_GAME_LINE =
  "I rebuilt your whole game to do that! If anything else now looks different or broken, tell me and I'll fix it! 🛠️";

/** Kid-facing line for an ACCEPTED whole-game regeneration on an edit turn:
 *  the model's own prose with all code stripped, or the honest
 *  REBUILT_GAME_LINE when it wrote code only. Never leaks fences, raw HTML,
 *  or a misleading "small change done" default into the chat bubble. */
export function regenReplyProse(reply: string): string {
  const prose = reply
    .replace(/```(?:\w+)?[\s\S]*?(?:```|$)/g, "") // fenced blocks, even unclosed/truncated
    .replace(/<!doctype html[\s\S]*$/i, "")
    .replace(/<html[\s>][\s\S]*$/i, "")
    .trim();
  if (!prose || /```|<\w+[\s>]/.test(prose) || prose === FRESH_GAME_LINE) return REBUILT_GAME_LINE;
  return prose;
}

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
If — and only if — the child is clearly asking for a COMPLETELY DIFFERENT game (a brand-new game, not a change, addition, or tweak to this one), do NOT rebuild anything: reply with exactly ${NEW_GAME_SENTINEL} on its own line, and nothing else at all (no sentence, no code). When in doubt, treat it as a change to the current game, not a new game.
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

/** Friendly line shown in place of streaming patch hunks (see below). */
export const EDIT_STREAM_WORKING_LINE = "Making your change… ✨";

/** Sanitizes a PARTIAL streaming reply for the chat bubble. BUG-FIX-LOG
 *  2026-07-18 ("not kid friendly"): the server-side prose split only runs
 *  when the stream FINISHES — while it streamed, the raw accumulated text
 *  (`<<<<<<< SEARCH` markers, code) was rendered live to the child. Cuts at
 *  the first run of `<<<<` (four or more — never legitimate prose, and it
 *  catches a marker still arriving at the stream tail) and swaps in a
 *  friendly working line. */
export function streamingDisplayText(partial: string): string {
  // A new-game self-declaration (NEW_GAME_SENTINEL) is an internal signal, not
  // an answer — hide it (and any prefix of it building token by token) so the
  // ugly token never flashes in the bubble before `done` swaps in the friendly
  // prompt. Only when the sentinel IS the whole partial (fail toward not hiding
  // real prose that merely happens to start with the same letters is a non-issue
  // — the token is unique and all-caps).
  const trimmed = partial.trim();
  if (trimmed && (NEW_GAME_SENTINEL.startsWith(trimmed) || trimmed === NEW_GAME_SENTINEL)) {
    return EDIT_STREAM_WORKING_LINE;
  }
  const idx = partial.search(/<{4}/);
  if (idx === -1) return partial;
  const prose = partial.slice(0, idx).trim();
  return prose ? `${prose}\n\n${EDIT_STREAM_WORKING_LINE}` : EDIT_STREAM_WORKING_LINE;
}

/** System-instruction section for the ONE hunks-only retry the route makes
 *  when the model answered an edit turn with a full rewrite instead of a
 *  patch (penguin-maze hardening 2026-07-18: 17 of 18 real edit turns took
 *  the rewrite loophole, regressing untouched parts every time). Appended to
 *  the child-safety base prompt in gemini.ts's strictEditRetry(). The
 *  NEEDS_FULL_REBUILD sentinel is the model's honest out — better than
 *  hallucinating hunks for a change that genuinely touches everything. */
export const GAME_EDIT_STRICT_RETRY_SECTION = `You just answered a request to change the child's existing game by rewriting the ENTIRE file. That loses their work: parts they never asked about get changed or broken. Do it again, correctly this time.
You will be given the CURRENT game source and the child's request. Reply with:
First, on its own line, ONE short encouraging sentence about the change (no code).
Then the change as SEARCH/REPLACE blocks ONLY, in EXACTLY this format:
<<<<<<< SEARCH
(lines copied EXACTLY, character for character, from the current source)
=======
(the replacement lines)
>>>>>>> REPLACE
Rules:
- The SEARCH text must match the current source exactly and uniquely.
- Change ONLY what the request needs; everything else stays byte-for-byte identical.
- No markdown fences, no full HTML document, nothing after the blocks.
- ONLY if the request truly cannot be done without rebuilding most of the file, reply with exactly NEEDS_FULL_REBUILD on a single line and nothing else.`;

/** Appended to the build/edit system instruction when the child re-sent the
 *  same message (isRepeatedRequest): the previous reply claimed success but
 *  the change never showed up on their screen — re-claiming success is the
 *  one guaranteed-wrong answer. */
export const REPEATED_REQUEST_SECTION = `IMPORTANT: The child has just sent the SAME message again, word for word. That means your previous reply did NOT work — whatever you said you changed never showed up in their game, even though you claimed it did. Do not repeat the same approach and do not claim success the same way again. Re-read the request, rebuild that specific part in a DIFFERENT way, and double-check the change is actually visible and playable in the game you return.`;
