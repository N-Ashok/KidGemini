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
import { stripInjectedRuntime } from "./assets/strip-runtime";
import type { ChatMessage } from "@/types/chat.types";

/** Last N messages sent to the model (≈ 6 back-and-forth turns). */
export const HISTORY_WINDOW = 12;

export const GAME_OMITTED_PLACEHOLDER =
  "[an earlier version of the game — code omitted, the newest version appears later in this conversation]";

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
  const { text } = extractArtifact(m.text);
  return { ...m, text: `${text}\n${GAME_OMITTED_PLACEHOLDER}`.trim() };
}

/** The CURRENT game's message must show its full source to the model — a
 *  prose-only patch-turn message re-inlines it from the field, so the exact
 *  lines the model copies into SEARCH blocks are the exact lines applyPatch
 *  will look for. A message whose text already carries the code is returned
 *  unchanged (never double-inlined). */
function withInlineGame(m: ChatMessage): ChatMessage {
  if (!m.artifactHtml || extractArtifact(m.text).artifactHtml !== undefined) return m;
  // Inline the game WITHOUT our injected runtime (2026-08-16). Measured on
  // real stored games, that runtime is ~8,400 of the ~21,000 input tokens an
  // edit turn costs — the loadModel/placeModel helper, the asset tables, the
  // perf probe, the WebGL guard and the governors, all code we wrote and
  // inject ourselves, replayed so the model can read our WebGL guard while
  // moving a house. The model never edits any of it and ensureAssetRuntime
  // puts it all back on delivery.
  //
  // SAFE FOR PATCHING because the strip only removes whole injected blocks
  // and leaves the child's own code byte-identical: a SEARCH block quoting
  // the game still matches the stored html applyPatch runs against. See
  // strip-runtime.test.ts, which pins exactly that.
  const source = stripInjectedRuntime(m.artifactHtml);
  return { ...m, text: `${m.text}\n\`\`\`html\n${source}\n\`\`\``.trim() };
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

  // 1) Strip every game except the current one (newest, or the pinned one) —
  //    and make sure the current one actually SHOWS its source (see
  //    withInlineGame: a patch-turn message carries it only in the field).
  const stripped = history.map((m, i) =>
    i === lastGameIdx ? withInlineGame(m) : hasGame(m) ? stripGame(m) : m,
  );

  // 2) Window to the most recent messages.
  if (stripped.length <= HISTORY_WINDOW) return stripped;
  const windowed = stripped.slice(-HISTORY_WINDOW);

  // 3) The current game must stay visible to the model even after windowing —
  //    swap it in for the oldest windowed message so the cap still holds.
  if (lastGameIdx !== -1 && lastGameIdx < stripped.length - HISTORY_WINDOW) {
    return [stripped[lastGameIdx]!, ...windowed.slice(1)];
  }
  return windowed;
}
