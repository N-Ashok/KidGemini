// Input-token diet for the chat model. The client sends the WHOLE conversation
// as history, and every assistant reply that built a game carries the full
// game HTML inline (~10-15K tokens per version) — so a kid iterating on a game
// re-sent every prior version on every message. This module trims what the
// MODEL sees (the stored conversation / UI is untouched):
//   1. Only the LATEST game's code survives — the model needs it to apply
//      "update" requests; older versions collapse to a one-line placeholder.
//   2. A sliding window keeps the last HISTORY_WINDOW messages, except the
//      latest game-bearing message is carried along if it fell outside, so
//      "now add a turbo" still has the code to work from after a long chat.
// Pure function — no I/O, no framework imports (extractArtifact is pure too).

import { extractArtifact } from "./gemini";
import type { ChatMessage } from "@/types/chat.types";

/** Last N messages sent to the model (≈ 6 back-and-forth turns). */
export const HISTORY_WINDOW = 12;
/** 2026-08-25 PRD_EditTurnCost §4.A (PRD-PROMPT-CACHING Fix A): the window
 *  cuts in BLOCKS. History is left alone until it exceeds WINDOW + HYSTERESIS,
 *  then cut back to WINDOW — so between cuts turn N+1's history is turn N's
 *  plus two appended messages, and Gemini's implicit cache (longest
 *  byte-identical prefix) can actually hit. A slide-by-one window shifted
 *  every byte every turn: measured 2–4% cached in prod. */
export const HISTORY_HYSTERESIS = 6;

/** "off" restores the pre-2026-08-25 shape (newest game inlined in history).
 *  Rollback switch only — see .env.example. */
export function promptPrefixV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROMPT_PREFIX_V2 ?? "on").trim().toLowerCase() !== "off";
}

export const GAME_OMITTED_PLACEHOLDER =
  "[game code omitted — the current version of the game is attached to the child's latest message]";

/** True if an assistant message carries game code. BUG-FIX-LOG 2026-07-18
 *  ("search_not_found on every edit turn"): patch/fallback turns store
 *  PROSE-ONLY text — the game travels in the `artifactHtml` field. Checking
 *  text alone made the model see an OLD version as "the current game", so
 *  its SEARCH blocks never matched what applyPatch targets (the newest
 *  field). Field first — the same signal game-edit.ts's lastGameIndex uses —
 *  with the text scan kept for anything predating the field. */
function hasGame(m: ChatMessage): boolean {
  return m.role === "assistant" && (Boolean(m.artifactHtml) || extractArtifact(m.text).artifactHtml !== undefined);
}

/** Replace the game code inside an assistant message with the placeholder,
 *  keeping the surrounding prose (extractArtifact already computes it). */
function stripGame(m: ChatMessage): ChatMessage {
  const { text, artifactHtml } = extractArtifact(m.text);
  // The source leaves the TEXT (never in history) but must stay ON the message:
  // currentGameHtml() reads `artifactHtml` to build the tail block and to
  // patch against. A legacy message that carried the game only in its text is
  // lifted here so the tail can still carry it.
  return {
    ...m,
    text: `${text}\n${GAME_OMITTED_PLACEHOLDER}`.trim(),
    ...(m.artifactHtml || !artifactHtml ? {} : { artifactHtml }),
  };
}

/** The CURRENT game's message must show its full source to the model — a
 *  prose-only patch-turn message re-inlines it from the field, so the exact
 *  lines the model copies into SEARCH blocks are the exact lines applyPatch
 *  will look for. A message whose text already carries the code is returned
 *  unchanged (never double-inlined). */
function withInlineGame(m: ChatMessage): ChatMessage {
  if (!m.artifactHtml || extractArtifact(m.text).artifactHtml !== undefined) return m;
  return { ...m, text: `${m.text}\n\`\`\`html\n${m.artifactHtml}\n\`\`\``.trim() };
}

/** Index of the message holding the CURRENT game — normally the newest one,
 *  or -1 if no game exists yet. `pinnedId` (chat-rewind.ts's "Continue from
 *  here") overrides recency: when set and it names a real game message, THAT
 *  index wins even if later game messages exist, so an edit turn builds on
 *  the pinned version while everything after it stays in the conversation
 *  untouched. Falls back to newest if the id isn't found (e.g. stale pin). */
export function findLastGameIndex(history: ChatMessage[], pinnedId?: string): number {
  if (pinnedId) {
    const pinned = history.findIndex((m) => m.id === pinnedId && hasGame(m));
    if (pinned !== -1) return pinned;
  }
  return history.reduce((acc, m, i) => (hasGame(m) ? i : acc), -1);
}

export function trimHistory(history: ChatMessage[], pinnedId?: string): ChatMessage[] {
  const lastGameIdx = findLastGameIndex(history, pinnedId);

  if (!promptPrefixV2Enabled()) {
    // Legacy shape (pre-2026-08-25): newest/pinned game inlined in history,
    // sliding window. Kept verbatim as the rollback path.
    const legacy = history.map((m, i) =>
      i === lastGameIdx ? withInlineGame(m) : hasGame(m) ? stripGame(m) : m,
    );
    if (legacy.length <= HISTORY_WINDOW) return legacy;
    const w = legacy.slice(-HISTORY_WINDOW);
    if (lastGameIdx !== -1 && lastGameIdx < legacy.length - HISTORY_WINDOW) return [legacy[lastGameIdx]!, ...w.slice(1)];
    return w;
  }

  // 1. EVERY game message becomes prose + a fixed placeholder — including the
  //    current one. The current source rides the final user turn instead
  //    (gemini.ts buildContents → gameSourceBlock), read from `artifactHtml`
  //    via currentGameHtml(). Bytes in history never change once written.
  const stripped = history.map((m) => (hasGame(m) ? stripGame(m) : m));

  // 2. Hysteresis window: cut in blocks, not by one message per turn.
  if (stripped.length <= HISTORY_WINDOW + HISTORY_HYSTERESIS) return stripped;
  const windowed = stripped.slice(-HISTORY_WINDOW);

  // 3. The current game's message is carried when it falls off the window:
  //    isGameEditTurn / catalogGates / currentGameHtml all read the game off
  //    the trimmed history. (PRD-PROMPT-CACHING proposed deleting this rule;
  //    kept — without it a long chat silently turns an edit into a fresh
  //    build. It only changes bytes at a cut, which already invalidates.)
  if (lastGameIdx !== -1 && lastGameIdx < stripped.length - HISTORY_WINDOW) {
    return [stripped[lastGameIdx]!, ...windowed.slice(1)];
  }
  return windowed;
}
