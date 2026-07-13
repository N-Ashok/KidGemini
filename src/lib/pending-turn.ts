// Tab-close recovery (owner decision 2026-07-13: the server's finished reply
// MUST end up in the chat). The device remembers its one in-flight turn; on
// the next app load, the container polls /api/chat/result for it and fills
// the waiting bubble. Cleared when a turn finalizes normally. Never throws.

export interface PendingTurn {
  replyId: string;
  convoId: string;
  startedAt: number;
}

const KEY = "kidgemini:pending-turn:v1";

export function savePendingTurn(storage: Storage, turn: PendingTurn): void {
  try {
    storage.setItem(KEY, JSON.stringify(turn));
  } catch {
    /* quota/private mode — recovery just won't be available */
  }
}

export function clearPendingTurn(storage: Storage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** The recorded in-flight turn, or null (also null once older than 24h —
 *  matching the server's turn_results TTL, there is nothing left to fetch). */
export function loadPendingTurn(storage: Storage, now: number = Date.now()): PendingTurn | null {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as PendingTurn;
    if (typeof t.replyId !== "string" || typeof t.convoId !== "string" || typeof t.startedAt !== "number") return null;
    if (now - t.startedAt > 24 * 60 * 60 * 1000) return null;
    return t;
  } catch {
    return null;
  }
}
