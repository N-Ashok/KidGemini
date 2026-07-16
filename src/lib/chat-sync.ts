// Client-side glue for server chat history (TECH_DEBT #26): merge the
// device's loaded chats with the server's paginated index for the sidebar.
// Pure functions — fetching stays in the container.

import type { ConvoSummary } from "@/types/chat-history.types";

/** Set once the device's pre-existing chats have been uploaded to the account. */
export const SYNC_FLAG = "kidgemini:chats:synced:v1";

/**
 * Sidebar list = the locally loaded chats (already searched over title AND
 * message text by the caller) followed by server-only chats not on this
 * device. Server entries carry no messages, so search filters them by title.
 */
export function mergeRecents(
  localRecents: Array<{ id: string; title: string }>,
  remote: ConvoSummary[],
  query: string,
): Array<{ id: string; title: string }> {
  const seen = new Set(localRecents.map((r) => r.id));
  const q = query.trim().toLowerCase();
  const remoteOnly = remote
    .filter((r) => !seen.has(r.id))
    .filter((r) => !q || r.title.toLowerCase().includes(q))
    .map((r) => ({ id: r.id, title: r.title }));
  return [...localRecents, ...remoteOnly];
}

/** Append a page, dropping ids we already have (a chat can move pages when
 *  it's written to between fetches). */
export function appendPage(prev: ConvoSummary[], page: ConvoSummary[]): ConvoSummary[] {
  const seen = new Set(prev.map((r) => r.id));
  return [...prev, ...page.filter((r) => !seen.has(r.id))];
}

/**
 * A fresh browser (or cleared storage) has no local chats at all, but the
 * account/guest identity may already have real history server-side — without
 * this, the main view silently defaulted to a blank "New chat" greeting even
 * though the SAME account's chats were sitting one click away in the sidebar
 * (reported: "I lose chat though I log into the same account... tied to the
 * browser rather than the account"). Returns the id of the most-recently-
 * updated server chat to auto-open, or null when there's nothing to restore
 * (remote is empty) or local data already exists — a device's OWN in-progress
 * chats are never overridden by a server restore.
 */
export function chatToAutoRestore(hadLocalChats: boolean, remoteIndex: ConvoSummary[]): string | null {
  if (hadLocalChats) return null;
  return remoteIndex[0]?.id ?? null; // newest-first per ChatHistoryStore.list()
}
