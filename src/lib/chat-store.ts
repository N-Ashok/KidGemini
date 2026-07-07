// Local persistence for chat conversations (BUG-FIX-LOG 2026-07-07: chats
// lived only in React state, so ANY navigation — sign-in round trip, Studio
// link — lost them). Device-local like the guest identity; server-side safety
// transcripts are unaffected. Pure functions: storage injected, never throws.

import type { Conversation } from "@/types/chat.types";

const KEY = "kidgemini:chats:v1";
const MAX_CONVOS = 20;

export function saveChats(storage: Storage, convos: Conversation[], activeId: string): void {
  try {
    storage.setItem(KEY, JSON.stringify({ convos: convos.slice(0, MAX_CONVOS), activeId }));
  } catch {
    /* quota/private mode — chat keeps working, just not persisted */
  }
}

export function loadChats(storage: Storage): { convos: Conversation[]; activeId: string } | null {
  try {
    const raw = storage.getItem(KEY);
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
