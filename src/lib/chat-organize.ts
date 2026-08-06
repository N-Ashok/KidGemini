// Rename + pin a chat (owner ask 2026-08-06, the sidebar ⋮ menu): pure
// client-state transitions, same pattern as chat-delete.ts — fetch + React
// wiring live in ChatPanel.container. Server-side these are PATCH
// /api/chats/:id { title } / { pinned }; a chat may exist only locally, only
// in the remote index, or both, so every transition updates both collections.

import type { Conversation } from "@/types/chat.types";
import type { ConvoSummary } from "@/types/chat-history.types";

export interface OrganizeResult {
  convos: Conversation[];
  remoteIndex: ConvoSummary[];
}

export function stateAfterRename(
  convos: Conversation[],
  remoteIndex: ConvoSummary[],
  id: string,
  title: string,
): OrganizeResult {
  return {
    convos: convos.map((c) => (c.id === id ? { ...c, title } : c)),
    remoteIndex: remoteIndex.map((r) => (r.id === id ? { ...r, title } : r)),
  };
}

/** `pinnedAt` = timestamp to pin, null to unpin. */
export function stateAfterPin(
  convos: Conversation[],
  remoteIndex: ConvoSummary[],
  id: string,
  pinnedAt: number | null,
): OrganizeResult {
  return {
    convos: convos.map((c) => (c.id === id ? { ...c, pinnedAt } : c)),
    remoteIndex: remoteIndex.map((r) => (r.id === id ? { ...r, pinnedAt } : r)),
  };
}

/** Pinned chats first (most recently pinned on top), everything else in its
 *  existing order — applied AFTER mergeRecents so server-only pinned chats
 *  float too. Stable for unpinned rows: recency order is untouched. */
export function sortPinnedFirst<T extends { pinnedAt?: number | null }>(items: T[]): T[] {
  const pinned = items
    .filter((i) => i.pinnedAt != null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  return [...pinned, ...items.filter((i) => i.pinnedAt == null)];
}
