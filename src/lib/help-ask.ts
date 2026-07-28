// Handoff from the 📚 Help Gallery back into the chat
// (docs/PRD-COMMUNITY-HELP.md §4.2 — "Ask Ari this" IS the whole feature).
//
// /help is its own route, so tapping a card has to survive one navigation. The
// device remembers the ONE prompt it's carrying and the container sends it
// through the normal handleSend → /api/chat path on arrival: nothing bypasses
// the safety path, and nothing is generated server-side by the gallery itself.
//
// Deliberately NOT pending-message.ts: that one is auth-interruption recovery
// and is bound to a conversation id and a signed-in session, neither of which
// applies here (a guest browsing the gallery must work). Same never-throws,
// short-TTL contract though.

export interface HelpAsk {
  text: string;
  savedAt: number;
}

const KEY = "kidgemini:help-ask:v1";
/** One navigation, not a resumable turn. A stale ask firing hours later would
 *  build a game the kid never asked for. */
const TTL_MS = 5 * 60 * 1000;

export function saveHelpAsk(storage: Storage, text: string): void {
  try {
    storage.setItem(KEY, JSON.stringify({ text, savedAt: Date.now() } satisfies HelpAsk));
  } catch {
    /* quota/private mode — the kid can still type the ask themselves */
  }
}

export function clearHelpAsk(storage: Storage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function loadHelpAsk(storage: Storage, now: number = Date.now()): string | null {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const ask = JSON.parse(raw) as HelpAsk;
    if (typeof ask.text !== "string" || !ask.text.trim() || typeof ask.savedAt !== "number") return null;
    if (now - ask.savedAt > TTL_MS) return null;
    return ask.text;
  } catch {
    return null;
  }
}
