// UsageSummary byDay — the admin "how much per day / who spent it" view.
// Uses an in-memory SQLite (no real .db file is ever touched — CLAUDE.md hard rule).
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteUsageStore } from "./db";

const DAY = 24 * 60 * 60 * 1000;
const geo = { ip: "203.0.113.9", country: null, region: null, city: null };

function ev(store: SqliteUsageStore, userId: string, label: string, tokens: number, at: number) {
  vi.spyOn(Date, "now").mockReturnValue(at);
  store.record({
    userId, userLabel: label, model: "m", kind: "chat",
    promptTokens: tokens, outputTokens: 0, costUsd: tokens / 1000,
    geo, requestText: "q", outputText: "a", blocked: false,
  });
  vi.restoreAllMocks();
}

describe("SqliteUsageStore.summarizeSince — byDay", () => {
  const store = new SqliteUsageStore();
  const T0 = Date.UTC(2026, 6, 1, 10, 0, 0); // 2026-07-01 10:00Z

  beforeAll(() => {
    ev(store, "user:a@x.com", "Ann", 5_000, T0);            // day 1
    ev(store, "user:b@x.com", "Bob", 1_000, T0 + 60_000);   // day 1
    ev(store, "user:b@x.com", "Bob", 9_000, T0 + DAY);      // day 2 — Bob top
    ev(store, "guest:g1", "Guest", 2_000, T0 + DAY + 1);    // day 2
  });

  it("D.1 groups totals per UTC day, newest first", () => {
    const s = store.summarizeSince(0);
    expect(s.byDay.map((d) => d.day)).toEqual(["2026-07-02", "2026-07-01"]);
    expect(s.byDay[1]).toMatchObject({ promptTokens: 6_000, eventCount: 2 });
    expect(s.byDay[0]).toMatchObject({ promptTokens: 11_000, eventCount: 2 });
  });

  it("D.2 names the top spender of each day", () => {
    const s = store.summarizeSince(0);
    expect(s.byDay[1]!.topUser).toMatchObject({ userId: "user:a@x.com", tokens: 5_000 });
    expect(s.byDay[0]!.topUser).toMatchObject({ userId: "user:b@x.com", tokens: 9_000 });
  });

  it("D.3 windowed tallies: tokensUsedByUser/guestTokensUsedByIp honor sinceMs", () => {
    expect(store.tokensUsedByUser("user:b@x.com", 0)).toBe(10_000);
    expect(store.tokensUsedByUser("user:b@x.com", T0 + DAY - 1)).toBe(9_000);
    expect(store.guestTokensUsedByIp(geo.ip, 0)).toBe(2_000); // guests only
    expect(store.guestTokensUsedByIp(geo.ip, T0 + DAY + 2)).toBe(0);
  });
});
