// Auth-interruption recovery (BUG-FIX-LOG 2026-07-14): a 401 gate (guest token
// limit / rate limit / paywall) fires mid-turn and abandons the message the
// kid was sending — they must retype it after signing in, which reads as "the
// chat died" and makes the whole detour feel slower than a real retry would.
// The device remembers the ONE message it was about to send; the container
// resubmits it once, automatically, after a successful sign-in.
//
// Deliberately text-only (no image attachments) — scoped to the common case,
// not the full generality of every possible turn. Survives the full-page
// redirect to the platform's /login and back (must be localStorage, not
// in-memory state, which that navigation would wipe).
//
// Short TTL (10 min) — this is "resume a keystroke," not "resume a running
// generation" (see pending-turn.ts for that, and its 24h TTL). Never throws.

export interface PendingMessage {
  text: string;
  convoId: string;
  savedAt: number;
}

const KEY = "kidgemini:pending-message:v1";
const TTL_MS = 10 * 60 * 1000;

export function savePendingMessage(storage: Storage, msg: PendingMessage): void {
  try {
    storage.setItem(KEY, JSON.stringify(msg));
  } catch {
    /* quota/private mode — recovery just won't be available */
  }
}

export function clearPendingMessage(storage: Storage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function loadPendingMessage(storage: Storage, now: number = Date.now()): PendingMessage | null {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as PendingMessage;
    if (typeof m.text !== "string" || !m.text || typeof m.convoId !== "string" || typeof m.savedAt !== "number") {
      return null;
    }
    if (now - m.savedAt > TTL_MS) return null;
    return m;
  } catch {
    return null;
  }
}
