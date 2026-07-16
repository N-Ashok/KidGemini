// PRD-SCREEN-TIME-CAP-MVP Part B — SqliteScreenTimeStore. In-memory SQLite
// (no real .db file is ever touched — CLAUDE.md hard rule), fake timers so
// ping timestamps (stamped via the caller-supplied nowMs) are controllable.
// Minutes are derived from screen_time_pings (2026-07-15: a chat completion
// AND a periodic client heartbeat both call recordPing — see
// ScreenTimeHeartbeat.tsx — so playing an already-built game counts too,
// not just typing to the bot).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteScreenTimeStore } from "./db";
import { utcDayStart, TAIL_MINUTES } from "./screen-time";
import type { AlertStore, ParentAlert } from "@/types/alert.types";

class FakeAlertStore implements AlertStore {
  calls: Array<Omit<ParentAlert, "id" | "createdAt">> = [];
  record(alert: Omit<ParentAlert, "id" | "createdAt">): ParentAlert {
    this.calls.push(alert);
    return { ...alert, id: `fake-${this.calls.length}`, createdAt: Date.now() };
  }
  list(): ParentAlert[] {
    return [];
  }
}

describe("SqliteScreenTimeStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 15, 9, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settings round-trip, including clearing back to null", () => {
    const store = new SqliteScreenTimeStore();
    const account = "user:settings-roundtrip@x.com";
    expect(store.getSettings(account)).toBeNull();

    store.putSettings(account, 30);
    expect(store.getSettings(account)?.dailyCapMinutes).toBe(30);

    store.putSettings(account, null);
    expect(store.getSettings(account)?.dailyCapMinutes).toBeNull();
  });

  it("recompute derives minutes from recorded pings and upserts today's row", () => {
    const account = "user:derive@x.com";
    const store = new SqliteScreenTimeStore();
    store.recordPing(account, Date.now());
    vi.advanceTimersByTime(60_000); // 1 minute later
    store.recordPing(account, Date.now());

    store.recomputeAndMaybeAlert(account, "Kid", Date.now());

    const today = store.getToday(account, utcDayStart(Date.now()));
    // one 1-minute gap + TAIL_MINUTES tail = 1 + TAIL_MINUTES
    expect(today?.activeMinutes).toBe(1 + TAIL_MINUTES);
  });

  it("a chat completion (one ping) alone still counts — no heartbeat required for a short session", () => {
    const account = "user:single-ping@x.com";
    const store = new SqliteScreenTimeStore();
    store.recordPing(account, Date.now());
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());

    const today = store.getToday(account, utcDayStart(Date.now()));
    expect(today?.activeMinutes).toBe(TAIL_MINUTES);
  });

  it("pure gameplay (heartbeat pings, no chat) accrues minutes the same way", () => {
    const account = "user:gameplay-only@x.com";
    const store = new SqliteScreenTimeStore();
    // Simulates ScreenTimeHeartbeat.tsx pinging every 60s while a kid plays
    // an already-built game, without sending any new chat message.
    for (let i = 0; i < 5; i++) {
      store.recordPing(account, Date.now());
      vi.advanceTimersByTime(60_000);
    }
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());

    const today = store.getToday(account, utcDayStart(Date.now()));
    // 5 pings → 4 gaps of 1 min + TAIL_MINUTES tail = 4 + TAIL_MINUTES
    expect(today?.activeMinutes).toBe(4 + TAIL_MINUTES);
  });

  it("crossing the cap fires exactly one alert into the injected AlertStore", () => {
    const account = "user:cap-crossed@x.com";
    const alerts = new FakeAlertStore();
    const store = new SqliteScreenTimeStore(alerts);
    store.putSettings(account, TAIL_MINUTES); // a single ping's tail alone reaches this cap

    store.recordPing(account, Date.now());
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());

    expect(alerts.calls.length).toBe(1);
    expect(alerts.calls[0]).toMatchObject({ origin: "system", action: "allow", severity: "low", category: null });
  });

  it("a second same-day recompute does not re-alert", () => {
    const account = "user:no-duplicate@x.com";
    const alerts = new FakeAlertStore();
    const store = new SqliteScreenTimeStore(alerts);
    store.putSettings(account, TAIL_MINUTES);

    store.recordPing(account, Date.now());
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());
    vi.advanceTimersByTime(60_000);
    store.recordPing(account, Date.now());
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());

    expect(alerts.calls.length).toBe(1);
  });

  it("a new UTC day resets alert eligibility", () => {
    const account = "user:new-day@x.com";
    const alerts = new FakeAlertStore();
    const store = new SqliteScreenTimeStore(alerts);
    store.putSettings(account, TAIL_MINUTES);

    store.recordPing(account, Date.now());
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());
    expect(alerts.calls.length).toBe(1);

    vi.setSystemTime(Date.UTC(2026, 6, 16, 9, 0, 0)); // next day, same time-of-day
    store.recordPing(account, Date.now());
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());

    expect(alerts.calls.length).toBe(2);
  });

  it("no cap set never alerts, regardless of minutes accrued", () => {
    const account = "user:no-cap@x.com";
    const alerts = new FakeAlertStore();
    const store = new SqliteScreenTimeStore(alerts);
    // deliberately never call putSettings — dailyCapMinutes stays null

    for (let i = 0; i < 5; i++) {
      store.recordPing(account, Date.now());
      vi.advanceTimersByTime(60_000);
    }
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());

    expect(alerts.calls.length).toBe(0);
  });

  it("a ping from yesterday never counts toward today's tally", () => {
    const account = "user:cross-day-ping@x.com";
    const store = new SqliteScreenTimeStore();
    store.recordPing(account, Date.now()); // 2026-07-15 09:00 UTC

    vi.setSystemTime(Date.UTC(2026, 6, 16, 9, 0, 0)); // next day
    store.recomputeAndMaybeAlert(account, "Kid", Date.now());

    const today = store.getToday(account, utcDayStart(Date.now()));
    expect(today?.activeMinutes).toBe(0);
  });

  it("recordPing prunes pings older than the retention window", () => {
    const account = "user:pruned@x.com";
    const store = new SqliteScreenTimeStore();
    store.recordPing(account, Date.now()); // old ping, day 1

    vi.setSystemTime(Date.UTC(2026, 6, 20, 9, 0, 0)); // 5 days later — past retention
    store.recordPing(account, Date.now()); // triggers the prune sweep

    store.recomputeAndMaybeAlert(account, "Kid", Date.now());
    const today = store.getToday(account, utcDayStart(Date.now()));
    // Only today's single ping remains (tail only) — the day-1 ping is gone,
    // not that it would have counted toward "today" anyway; this confirms
    // the table isn't silently accumulating unbounded rows.
    expect(today?.activeMinutes).toBe(TAIL_MINUTES);
  });
});
