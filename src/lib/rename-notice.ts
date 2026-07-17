// One-time "KidGemini is now called Ari" notice (2026-07-17 rename).
// Pure, storage-injected, fail-open — same seen/dismiss contract as
// idea-coach.ts. Deliberately decoupled from the chat-hydration bootstrap in
// ChatPanel.container.tsx (that timing is fragile — see its own comments on
// the cross-browser restore bug) rather than reusing its already-loaded
// state: this does its own independent, read-only localStorage check on
// mount, so it can't interact with or destabilize that logic. Trade-off:
// misses the rare cross-device case where a kid's only history is
// server-side with nothing local yet — acceptable, since the cost of a miss
// is just "the notice doesn't show," not a data or safety issue.

import type { Conversation } from "@/types/chat.types";
import { loadChats } from "./chat-store";

export interface RenameNoticeStore {
  seen: boolean;
}

const KEY = "ari:rename-notice:v1";

export const RENAME_NOTICE_LINE =
  "KidGemini is now called Ari! Same buddy, same games, new name. 🎉";

export function defaultRenameNoticeStore(): RenameNoticeStore {
  return { seen: false };
}

/** A greeting-only conversation (nothing sent yet) doesn't count as "prior
 *  history" — same threshold ChatPanel.container.tsx already uses for "is
 *  there anything here worth keeping." */
function hasRealHistory(convos: Conversation[]): boolean {
  return convos.some((c) => c.messages.length >= 2);
}

/** Show only to a device with prior history — a brand-new visitor after the
 *  rename never knew "KidGemini" existed, so telling them it changed would
 *  just be confusing (and reads worse than simply never mentioning it). */
export function shouldShowRenameNotice(storage: Storage, store: RenameNoticeStore): boolean {
  if (store.seen) return false;
  const saved = loadChats(storage);
  return saved ? hasRealHistory(saved.convos) : false;
}

export function saveRenameNotice(storage: Storage, store: RenameNoticeStore): void {
  try {
    storage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota/private mode — worst case the notice shows again next visit */
  }
}

export function loadRenameNotice(storage: Storage): RenameNoticeStore {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return defaultRenameNoticeStore();
    const p = JSON.parse(raw) as Partial<RenameNoticeStore>;
    if (typeof p.seen !== "boolean") return defaultRenameNoticeStore();
    return { seen: p.seen };
  } catch {
    return defaultRenameNoticeStore();
  }
}
