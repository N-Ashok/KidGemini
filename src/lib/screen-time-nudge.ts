// Once-per-UTC-day "nearing your screen-time cap" child-facing nudge banner
// (Feature 4, 2026-07-28). Mirrors rename-notice.ts's shown-tracking
// contract exactly: pure, storage-injected, fail-open. Unlike rename-notice
// (shown at most once ever), this resets daily — a new UTC day means a new
// cap window, so a kid who logs in tomorrow and approaches the cap again
// should see it again. The key is namespaced per UTC-day-start so yesterday's
// "seen" doesn't suppress today's.

export interface ScreenTimeNudgeStore {
  seen: boolean;
}

const KEY_PREFIX = "ari:screentime-nudge:v1:";

export const SCREEN_TIME_NUDGE_LINE =
  "You've been chatting for a while today — almost time to wrap up soon! 🌙";

function keyFor(utcDayStartMs: number): string {
  return `${KEY_PREFIX}${utcDayStartMs}`;
}

export function defaultScreenTimeNudgeStore(): ScreenTimeNudgeStore {
  return { seen: false };
}

export function loadScreenTimeNudge(storage: Storage, utcDayStartMs: number): ScreenTimeNudgeStore {
  try {
    const raw = storage.getItem(keyFor(utcDayStartMs));
    if (!raw) return defaultScreenTimeNudgeStore();
    const p = JSON.parse(raw) as Partial<ScreenTimeNudgeStore>;
    if (typeof p.seen !== "boolean") return defaultScreenTimeNudgeStore();
    return { seen: p.seen };
  } catch {
    return defaultScreenTimeNudgeStore();
  }
}

export function saveScreenTimeNudge(storage: Storage, utcDayStartMs: number, store: ScreenTimeNudgeStore): void {
  try {
    storage.setItem(keyFor(utcDayStartMs), JSON.stringify(store));
  } catch {
    /* quota/private mode — worst case the banner shows again this session */
  }
}

/** Not shown today already ⇒ show. The "nearing cap" server signal is the
 *  real gate on WHEN this is called; this only prevents re-showing after a
 *  dismiss within the same UTC day. */
export function shouldShowScreenTimeNudge(store: ScreenTimeNudgeStore): boolean {
  return !store.seen;
}
