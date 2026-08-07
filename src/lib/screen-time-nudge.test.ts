// Feature 4 (2026-07-28) — once-per-UTC-day shown-tracking for the child
// nudge banner. Storage-fake approach (pattern from the since-retired
// rename-notice tests, removed 2026-08-08).
import { describe, it, expect } from "vitest";
import {
  defaultScreenTimeNudgeStore,
  loadScreenTimeNudge,
  saveScreenTimeNudge,
  shouldShowScreenTimeNudge,
} from "./screen-time-nudge";

class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const DAY_1 = 1_752_537_600_000; // arbitrary UTC-midnight-like value
const DAY_2 = DAY_1 + 86_400_000;

describe("screen-time-nudge", () => {
  it("defaults to unseen", () => {
    expect(defaultScreenTimeNudgeStore()).toEqual({ seen: false });
  });

  it("shouldShowScreenTimeNudge is true when unseen, false once seen", () => {
    expect(shouldShowScreenTimeNudge({ seen: false })).toBe(true);
    expect(shouldShowScreenTimeNudge({ seen: true })).toBe(false);
  });

  it("loadScreenTimeNudge round-trips through saveScreenTimeNudge for the same day", () => {
    const storage = new FakeStorage();
    expect(loadScreenTimeNudge(storage, DAY_1)).toEqual({ seen: false });

    saveScreenTimeNudge(storage, DAY_1, { seen: true });
    expect(loadScreenTimeNudge(storage, DAY_1)).toEqual({ seen: true });
  });

  it("a dismissal on one UTC day does not suppress the banner on a different day", () => {
    const storage = new FakeStorage();
    saveScreenTimeNudge(storage, DAY_1, { seen: true });

    expect(loadScreenTimeNudge(storage, DAY_1)).toEqual({ seen: true });
    expect(loadScreenTimeNudge(storage, DAY_2)).toEqual({ seen: false });
  });

  it("malformed/corrupt storage content falls back to the default, not a throw", () => {
    const storage = new FakeStorage();
    storage.setItem("ari:screentime-nudge:v1:" + DAY_1, "{not json");
    expect(loadScreenTimeNudge(storage, DAY_1)).toEqual({ seen: false });

    storage.setItem("ari:screentime-nudge:v1:" + DAY_1, JSON.stringify({ seen: "yes" }));
    expect(loadScreenTimeNudge(storage, DAY_1)).toEqual({ seen: false });
  });
});
