import { describe, it, expect } from "vitest";
import { evaluate, startOfNextDay } from "./rate-limit";
import type { IpLimitRecord } from "@/types/rate-limit.types";

// Fixed clock: 2026-06-24T12:00:00Z. Pure logic, so no fake timers needed.
const NOW = Date.UTC(2026, 5, 24, 12, 0, 0);
const CFG = { windowMs: 5 * 60_000, maxInWindow: 30, strikesBeforePay: 3 } as const;
const IP = "1.2.3.4";

/** Replay `n` requests through evaluate(), threading the record. Returns the last result. */
function replay(n: number, start: IpLimitRecord | null, now = NOW) {
  let record = start;
  let status = evaluate(record ?? null, IP, now, CFG).status;
  for (let i = 0; i < n; i++) {
    const r = evaluate(record, IP, now, CFG);
    record = r.record;
    status = r.status;
  }
  return { record: record!, status };
}

describe("startOfNextDay", () => {
  it("returns next UTC midnight", () => {
    expect(startOfNextDay(NOW)).toBe(Date.UTC(2026, 5, 25, 0, 0, 0));
  });
  it("is stable across the same day", () => {
    expect(startOfNextDay(Date.UTC(2026, 5, 24, 23, 59, 59))).toBe(Date.UTC(2026, 5, 25, 0, 0, 0));
  });
});

describe("evaluate — within limit", () => {
  it("allows the first request and starts a window", () => {
    const { record, status } = evaluate(null, IP, NOW, CFG);
    expect(status).toEqual({ state: "ok" });
    expect(record).toMatchObject({ ip: IP, count: 1, blockedUntil: 0, strikes: 0, windowStart: NOW });
  });

  it("allows exactly maxInWindow requests", () => {
    const { status } = replay(CFG.maxInWindow, null);
    expect(status).toEqual({ state: "ok" });
  });
});

describe("evaluate — over limit", () => {
  it("blocks the (max+1)th request until next day, first strike (no pay yet)", () => {
    const { status, record } = replay(CFG.maxInWindow + 1, null);
    expect(status).toEqual({
      state: "blocked",
      until: startOfNextDay(NOW),
      mustPay: false,
    });
    expect(record.strikes).toBe(1);
  });

  it("keeps rejecting while blocked without adding strikes", () => {
    const blocked = replay(CFG.maxInWindow + 1, null).record;
    const again = evaluate(blocked, IP, NOW + 60_000, CFG); // 1 min later, still same day
    expect(again.status.state).toBe("blocked");
    expect(again.record.strikes).toBe(1); // unchanged — a block doesn't re-strike
  });
});

describe("evaluate — window reset", () => {
  it("resets the count after the window elapses", () => {
    const filled = replay(CFG.maxInWindow, null).record; // 30 used, not blocked
    const later = evaluate(filled, IP, NOW + CFG.windowMs, CFG); // window rolled over
    expect(later.status).toEqual({ state: "ok" });
    expect(later.record.count).toBe(1);
  });
});

describe("evaluate — strikes escalate to pay", () => {
  it("sets mustPay once strikes reach the cap", () => {
    // Simulate two prior strikes already on the record, block expired.
    const twoStrikes: IpLimitRecord = {
      ip: IP,
      windowStart: NOW - CFG.windowMs,
      count: 0,
      blockedUntil: NOW - 1, // expired
      strikes: 2,
    };
    const { status, record } = replay(CFG.maxInWindow + 1, twoStrikes);
    expect(record.strikes).toBe(3);
    expect(status).toEqual({ state: "blocked", until: startOfNextDay(NOW), mustPay: true });
  });

  it("an already-struck-out IP sees mustPay even while just waiting", () => {
    const struckOut: IpLimitRecord = {
      ip: IP,
      windowStart: NOW,
      count: CFG.maxInWindow + 1,
      blockedUntil: startOfNextDay(NOW),
      strikes: 3,
    };
    const { status } = evaluate(struckOut, IP, NOW + 1000, CFG);
    expect(status).toEqual({ state: "blocked", until: startOfNextDay(NOW), mustPay: true });
  });
});

describe("evaluate — recovery after block expires", () => {
  it("allows again the next day, retaining the strike count", () => {
    const blocked = replay(CFG.maxInWindow + 1, null).record; // strikes: 1, blocked
    const nextDay = startOfNextDay(NOW) + 1000;
    const recovered = evaluate(blocked, IP, nextDay, CFG);
    expect(recovered.status).toEqual({ state: "ok" });
    expect(recovered.record.count).toBe(1);
    expect(recovered.record.strikes).toBe(1); // memory persists for the 3-strike rule
    expect(recovered.record.blockedUntil).toBe(0);
  });
});
