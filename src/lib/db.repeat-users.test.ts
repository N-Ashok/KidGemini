// repeatUsersSince — the admin "who keeps coming back" list (2026-07-14):
// users (accounts AND guest cookies) active on 2+ distinct IST days.
// Same-day repeat requests are engagement, not a return visit.
// Uses an in-memory SQLite (no real .db file is ever touched — CLAUDE.md hard rule).
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteUsageStore } from "./db";

const DAY = 24 * 60 * 60 * 1000;

function ev(store: SqliteUsageStore, at: number, userId: string, label: string | null) {
  vi.spyOn(Date, "now").mockReturnValue(at);
  store.record({
    userId, userLabel: label, model: "m", kind: "chat",
    promptTokens: 10, outputTokens: 10, costUsd: 0.001,
    geo: { ip: "203.0.113.9", country: null, region: null, city: null },
    requestText: "q", outputText: "a", blocked: false,
  });
  vi.restoreAllMocks();
}

describe("SqliteUsageStore.repeatUsersSince", () => {
  const store = new SqliteUsageStore();
  // 2026-07-01 10:00 IST = 04:30Z — safely inside one IST day.
  const T0 = Date.UTC(2026, 6, 1, 4, 30);

  beforeAll(() => {
    // Ann: 3 requests across 2 IST days → returning.
    ev(store, T0, "user:ann@x.com", "Ann");
    ev(store, T0 + 60_000, "user:ann@x.com", "Ann");
    ev(store, T0 + DAY, "user:ann@x.com", "Ann");
    // Bob: 5 requests, all the SAME day → not returning.
    for (let i = 0; i < 5; i++) ev(store, T0 + i * 1000, "user:bob@x.com", "Bob");
    // Guest cookie back on 3 days → returning (guests count too).
    ev(store, T0, "guest:g1", "Guest");
    ev(store, T0 + DAY, "guest:g1", "Guest");
    ev(store, T0 + 2 * DAY, "guest:g1", "Guest");
    // IST-day edge: 2026-07-01 23:50 IST and 00:10 IST next day are one UTC
    // day (18:20Z and 18:40Z on Jul 1) but TWO IST days → returning.
    const istLateNight = Date.UTC(2026, 6, 1, 18, 20);
    ev(store, istLateNight, "user:eve@x.com", "Eve");
    ev(store, istLateNight + 20 * 60_000, "user:eve@x.com", "Eve");
  });

  it("R.1 lists only users active on 2+ distinct IST days, most days first", () => {
    const list = store.repeatUsersSince(0);
    expect(list.map((r) => r.userId)).toEqual(["guest:g1", "user:ann@x.com", "user:eve@x.com"]);
    expect(list[0]).toMatchObject({ activeDays: 3, eventCount: 3, userLabel: "Guest" });
    expect(list[1]).toMatchObject({ activeDays: 2, eventCount: 3 });
  });

  it("R.2 day boundaries are IST, not UTC (23:50 → 00:10 IST counts as a return)", () => {
    const eve = store.repeatUsersSince(0).find((r) => r.userId === "user:eve@x.com");
    expect(eve).toMatchObject({ activeDays: 2 });
  });

  it("R.3 tracks first and last seen timestamps", () => {
    const ann = store.repeatUsersSince(0).find((r) => r.userId === "user:ann@x.com")!;
    expect(ann.firstSeen).toBe(T0);
    expect(ann.lastSeen).toBe(T0 + DAY);
  });

  it("R.4 honors the window (old visits age out of the list)", () => {
    const recent = store.repeatUsersSince(T0 + DAY - 1);
    expect(recent.find((r) => r.userId === "user:ann@x.com")).toBeUndefined();
  });
});
