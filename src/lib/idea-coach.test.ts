// First-run coach for the Idea Button (docs/PRD-IDEA-BUTTON.md §coach):
// a pre-reader can't learn from a tooltip, so the mic tab introduces itself
// ONCE with voice + animation — and gets exactly one wiggle-only re-nudge if
// the kid never captures anything in their next few games. These rules are
// the product contract; pin them.
import { describe, expect, it } from "vitest";
import {
  defaultCoachStore,
  loadCoach,
  RENUDGE_AFTER_GAMES,
  saveCoach,
  shouldRenudge,
  shouldShowCoach,
  type CoachStore,
} from "./idea-coach";

function store(over: Partial<CoachStore> = {}): CoachStore {
  return { ...defaultCoachStore(), ...over };
}

function fakeStorage(init: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(init));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("shouldShowCoach — the full intro, once ever, only over a quiet playable game", () => {
  const ok = { seen: false, busy: false, micSupported: true };
  it("shows on the first quiet preview", () => {
    expect(shouldShowCoach(ok)).toBe(true);
  });
  it("never again once seen", () => {
    expect(shouldShowCoach({ ...ok, seen: true })).toBe(false);
  });
  it("never while a generation is streaming", () => {
    expect(shouldShowCoach({ ...ok, busy: true })).toBe(false);
  });
  it("never advertises a mic that can't work", () => {
    expect(shouldShowCoach({ ...ok, micSupported: false })).toBe(false);
  });
});

describe("shouldRenudge — ONE wiggle-only reminder, then silence forever", () => {
  it(`fires after ${RENUDGE_AFTER_GAMES} idea-less games post-intro`, () => {
    expect(shouldRenudge(store({ seen: true, gamesSinceCoach: RENUDGE_AFTER_GAMES }))).toBe(true);
  });
  it("not before the threshold", () => {
    expect(shouldRenudge(store({ seen: true, gamesSinceCoach: RENUDGE_AFTER_GAMES - 1 }))).toBe(false);
  });
  it("never if the kid has already captured an idea (they know it)", () => {
    expect(
      shouldRenudge(store({ seen: true, gamesSinceCoach: 9, everCaptured: true })),
    ).toBe(false);
  });
  it("never twice", () => {
    expect(shouldRenudge(store({ seen: true, gamesSinceCoach: 9, renudged: true }))).toBe(false);
  });
  it("never before the intro itself has played", () => {
    expect(shouldRenudge(store({ seen: false, gamesSinceCoach: 9 }))).toBe(false);
  });
});

describe("persistence — same never-throw contract as the other stores", () => {
  it("round-trips", () => {
    const s = fakeStorage();
    const st = store({ seen: true, gamesSinceCoach: 2, everCaptured: true, renudged: true });
    saveCoach(s, st);
    expect(loadCoach(s)).toEqual(st);
  });
  it("absent or garbage → safe defaults (coach WILL show — fail open on the intro)", () => {
    expect(loadCoach(fakeStorage())).toEqual(defaultCoachStore());
    expect(loadCoach(fakeStorage({ "kidgemini:idea-coach:v1": "{{nope" }))).toEqual(defaultCoachStore());
    expect(loadCoach(fakeStorage({ "kidgemini:idea-coach:v1": '{"seen":"yes"}' }))).toEqual(
      defaultCoachStore(),
    );
  });
  it("save never throws (quota / private mode)", () => {
    const s = fakeStorage();
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => saveCoach(s, store())).not.toThrow();
  });
});
