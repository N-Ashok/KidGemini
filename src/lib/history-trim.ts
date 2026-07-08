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

export const GAME_OMITTED_PLACEHOLDER =
  "[an earlier version of the game — code omitted, the newest version appears later in this conversation]";

/** True if an assistant message carries game code (fenced or raw document). */
function hasGame(m: ChatMessage): boolean {
  return m.role === "assistant" && extractArtifact(m.text).artifactHtml !== undefined;
}

/** Replace the game code inside an assistant message with the placeholder,
 *  keeping the surrounding prose (extractArtifact already computes it). */
function stripGame(m: ChatMessage): ChatMessage {
  const { text } = extractArtifact(m.text);
  return { ...m, text: `${text}\n${GAME_OMITTED_PLACEHOLDER}`.trim() };
}

export function trimHistory(history: ChatMessage[]): ChatMessage[] {
  const lastGameIdx = history.reduce((acc, m, i) => (hasGame(m) ? i : acc), -1);

  // 1) Strip every game except the newest one.
  const stripped = history.map((m, i) => (i !== lastGameIdx && hasGame(m) ? stripGame(m) : m));

  // 2) Window to the most recent messages.
  if (stripped.length <= HISTORY_WINDOW) return stripped;
  const windowed = stripped.slice(-HISTORY_WINDOW);

  // 3) The newest game must stay visible to the model even after windowing —
  //    swap it in for the oldest windowed message so the cap still holds.
  if (lastGameIdx !== -1 && lastGameIdx < stripped.length - HISTORY_WINDOW) {
    return [stripped[lastGameIdx]!, ...windowed.slice(1)];
  }
  return windowed;
}
