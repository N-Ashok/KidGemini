// First-run coach policy for the Idea Button (docs/PRD-IDEA-BUTTON.md §coach).
// The tab introduces itself ONCE with a silent bubble + demo animation (voice
// only via the 🔊 Hear it button), plus at most one wiggle-only re-nudge
// later. Pure, storage-injected, never throws — same contract as idea-bag.ts.

export interface CoachStore {
  /** The full intro has played (or been dismissed). */
  seen: boolean;
  /** Game previews opened since the intro without any idea captured. */
  gamesSinceCoach: number;
  /** The kid has captured at least one idea — they know the feature. */
  everCaptured: boolean;
  /** The one wiggle-only reminder has been spent. */
  renudged: boolean;
}

const KEY = "kidgemini:idea-coach:v1";
/** Idea-less game previews after the intro before the single re-nudge. */
export const RENUDGE_AFTER_GAMES = 3;

/** The line the bubble shows — the text + demo animation are the onboarding.
 *  The buddy voice reads this aloud only on request (the 🔊 Hear it button);
 *  the auto voice-over was removed as intrusive. */
export const COACH_LINE =
  "Hi! I'm your Idea Button! Tap me and say your idea — no typing! It lines up and Ari builds it.";

export function defaultCoachStore(): CoachStore {
  return { seen: false, gamesSinceCoach: 0, everCaptured: false, renudged: false };
}

/** The full intro: first quiet playable preview only. `covered` is enforced
 *  structurally (the coach renders where the verify cover isn't), so the
 *  policy gates on the rest. */
export function shouldShowCoach(s: { seen: boolean; busy: boolean; micSupported: boolean }): boolean {
  return !s.seen && !s.busy && s.micSupported;
}

/** ONE wiggle-only reminder, only after the intro, only while the feature has
 *  never been used, only once. */
export function shouldRenudge(store: CoachStore): boolean {
  return (
    store.seen &&
    !store.everCaptured &&
    !store.renudged &&
    store.gamesSinceCoach >= RENUDGE_AFTER_GAMES
  );
}

export function saveCoach(storage: Storage, store: CoachStore): void {
  try {
    storage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota/private mode — worst case the intro replays next visit */
  }
}

export function loadCoach(storage: Storage): CoachStore {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return defaultCoachStore();
    const p = JSON.parse(raw) as Partial<CoachStore>;
    if (
      typeof p.seen !== "boolean" ||
      typeof p.gamesSinceCoach !== "number" ||
      typeof p.everCaptured !== "boolean" ||
      typeof p.renudged !== "boolean"
    ) {
      return defaultCoachStore(); // fail open: the intro is harmless, losing it isn't
    }
    return { seen: p.seen, gamesSinceCoach: p.gamesSinceCoach, everCaptured: p.everCaptured, renudged: p.renudged };
  } catch {
    return defaultCoachStore();
  }
}
