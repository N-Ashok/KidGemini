// Delete-a-chat (owner ask 2026-07-26): pure client-state transition for
// removing one chat from the sidebar. Server-side this is a SOFT delete —
// /api/chats/:id DELETE hides the row from the account's view; the system
// keeps it (safety review, recoverability). Pure function; fetch + React
// wiring live in ChatPanel.container.

import type { Conversation } from "@/types/chat.types";
import type { ConvoSummary } from "@/types/chat-history.types";

export interface DeleteResult {
  convos: Conversation[];
  remoteIndex: ConvoSummary[];
  /** The chat to show next: unchanged when a background chat was deleted, the
   *  first remaining chat when the ACTIVE one was, or null when nothing local
   *  remains — the caller opens a fresh "New chat" (never a blank screen). */
  nextActiveId: string | null;
}

export function stateAfterDelete(
  convos: Conversation[],
  remoteIndex: ConvoSummary[],
  deletedId: string,
  activeId: string,
): DeleteResult {
  const nextConvos = convos.filter((c) => c.id !== deletedId);
  const nextRemote = remoteIndex.filter((r) => r.id !== deletedId);
  const nextActiveId =
    activeId !== deletedId ? activeId : (nextConvos[0]?.id ?? null);
  return { convos: nextConvos, remoteIndex: nextRemote, nextActiveId };
}
