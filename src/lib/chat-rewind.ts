// "Continue from here" — lets a kid/creator pick an EARLIER game version to
// keep building on when a later edit regressed it, WITHOUT losing the
// regressed messages from the chat. game-edit.ts's lastGameIndex and
// history-trim.ts's findLastGameIndex normally always target the newest game
// message in the conversation; Conversation.activeGameMessageId is a pin
// that overrides that for exactly the next turn (api/chat/route.ts reads it,
// game-edit.ts/history-trim.ts resolve it the same way "last game wins"
// already worked, just anchored to a specific id) — nothing in the message
// array is deleted or reordered. Framework-free so it's unit-testable (repo
// pattern: no @testing-library; logic lives here, components stay
// presentational).

import type { ChatMessage } from "@/types/chat.types";

/** True when message `index` should offer a "Continue from here" action: it
 *  carries a game, something exists after it to diverge from (there's
 *  nothing to "continue from" on the last message — it's already current),
 *  and it isn't already the pinned version. */
export function canContinueFromHere(
  messages: ChatMessage[],
  index: number,
  activeGameMessageId: string | undefined,
): boolean {
  const m = messages[index];
  if (!m?.artifactHtml) return false;
  if (index >= messages.length - 1) return false;
  if (activeGameMessageId === m.id) return false;
  return true;
}
