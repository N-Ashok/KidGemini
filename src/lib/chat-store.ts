// Local persistence for chat conversations (BUG-FIX-LOG 2026-07-07: chats
// lived only in React state, so ANY navigation — sign-in round trip, Studio
// link — lost them). Device-local like the guest identity; server-side safety
// transcripts are unaffected. Pure functions: storage injected, never throws.

import type { Conversation, Workspace } from "@/types/chat.types";

const KEY = "kidgemini:chats:v1";

/** Per-workspace storage key (PRD-BIBLE-TEACHER). The kid `default` app keeps
 *  the original key (zero migration, no data loss for existing devices); the
 *  bible-teacher surface gets its own bucket, so the two recents lists never
 *  bleed into each other on the same device. */
function keyFor(workspace: Workspace): string {
  return workspace === "default" ? KEY : `${KEY}:${workspace}`;
}

/**
 * Persist every conversation — NO arbitrary cap (BUG-FIX-LOG 2026-07-13: the
 * old hard 20-convo cap silently deleted older chats with no way to reach
 * them). The only limit is the browser's real localStorage quota: when a
 * write is refused, drop the OLDEST conversations (list is newest-first, so
 * trim from the tail) until it fits — halving each attempt keeps the retries
 * logarithmic even though each one re-serializes. The ACTIVE conversation is
 * always kept, wherever it sits in the list.
 */
export function saveChats(storage: Storage, convos: Conversation[], activeId: string, workspace: Workspace = "default"): void {
  const key = keyFor(workspace);
  for (let n = convos.length; n >= 1; n = Math.floor(n / 2)) {
    let keep = convos.slice(0, n);
    if (!keep.some((c) => c.id === activeId)) {
      const active = convos.find((c) => c.id === activeId);
      if (active) keep = [...keep.slice(0, Math.max(0, n - 1)), active];
    }
    try {
      storage.setItem(key, JSON.stringify({ convos: keep, activeId }));
      return;
    } catch {
      /* quota/private mode — try fewer; a 1-convo failure means no persistence */
    }
  }
}

export function loadChats(storage: Storage, workspace: Workspace = "default"): { convos: Conversation[]; activeId: string } | null {
  try {
    const raw = storage.getItem(keyFor(workspace));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { convos?: Conversation[]; activeId?: string };
    if (!Array.isArray(parsed.convos) || parsed.convos.length === 0) return null;
    const activeId = parsed.convos.some((c) => c.id === parsed.activeId)
      ? (parsed.activeId as string)
      : parsed.convos[0]!.id;
    return { convos: parsed.convos, activeId };
  } catch {
    return null;
  }
}
