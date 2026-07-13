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
