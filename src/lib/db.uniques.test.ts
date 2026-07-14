// uniquesSince — the admin "how many distinct people/machines" rollup
// (2026-07-14). Three signals, none perfect alone:
//   signedInUsers — distinct user:* ids (same person across devices = 1)
//   guestBrowsers — distinct guest:* cookie ids (per browser; cookie clears inflate)
//   guestDevices  — distinct (ip, userAgent) pairs among guests (dedupes
//                   re-minted cookies on the same machine; NAT can undercount)
// Uses an in-memory SQLite (no real .db file is ever touched — CLAUDE.md hard rule).
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteUsageStore } from "./db";

function ev(store: SqliteUsageStore, at: number, userId: string, ip: string, userAgent: string | null) {
  vi.spyOn(Date, "now").mockReturnValue(at);
  store.record({
    userId, userLabel: null, model: "m", kind: "chat",
    promptTokens: 10, outputTokens: 10, costUsd: 0.001, userAgent,
    geo: { ip, country: null, region: null, city: null },
    requestText: "q", outputText: "a", blocked: false,
  });
  vi.restoreAllMocks();
}

describe("SqliteUsageStore.uniquesSince", () => {
  const store = new SqliteUsageStore();
  const T0 = Date.UTC(2026, 6, 1);
  const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0";
  const UA_SAFARI = "Mozilla/5.0 (iPad; CPU OS 17_5) Safari/605.1";

  beforeAll(() => {
    // Two signed-in accounts; one of them from two different IPs (still 1 user).
    ev(store, T0, "user:a@x.com", "198.51.100.1", UA_CHROME);
    ev(store, T0 + 1, "user:a@x.com", "203.0.113.7", UA_CHROME);
    ev(store, T0 + 2, "user:b@x.com", "198.51.100.1", UA_SAFARI);
    // g1 and g2: SAME machine (same ip + user-agent) — a cleared cookie
    // re-minted the guest id. Browsers=2, devices=1.
    ev(store, T0 + 3, "guest:g1", "198.51.100.1", UA_CHROME);
    ev(store, T0 + 4, "guest:g1", "198.51.100.1", UA_CHROME);
    ev(store, T0 + 5, "guest:g2", "198.51.100.1", UA_CHROME);
    // g3: different network + browser — clearly another device.
    ev(store, T0 + 6, "guest:g3", "203.0.113.9", UA_SAFARI);
  });

  it("N.1 counts distinct signed-in accounts (multi-device = 1 user)", () => {
    expect(store.uniquesSince(0).signedInUsers).toBe(2);
  });

  it("N.2 counts guest browsers (cookies) and guest devices (ip+UA) separately", () => {
    const u = store.uniquesSince(0);
    expect(u.guestBrowsers).toBe(3); // g1, g2, g3
    expect(u.guestDevices).toBe(2); // (ipA, Chrome) + (ipB, Safari)
  });

  it("N.3 honors the window boundary", () => {
    const u = store.uniquesSince(T0 + 6);
    expect(u).toEqual({ signedInUsers: 0, guestBrowsers: 1, guestDevices: 1 });
  });

  it("N.4 userAgent round-trips on the event (and may be null)", () => {
    const rows = store.listSince(0);
    expect(rows.some((r) => r.userAgent === UA_CHROME)).toBe(true);
    ev(store, T0 + 7, "guest:g4", "203.0.113.9", null);
    expect(store.listSince(T0 + 7)[0]!.userAgent).toBeNull();
  });
});
