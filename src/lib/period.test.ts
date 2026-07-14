// IST calendar-period boundaries for the admin rollups (today / this week /
// this month / this year). The operator runs the business in India, so the
// dashboard's "today" is the IST day, not the UTC day.
import { describe, it, expect } from "vitest";
import { periodStartsIst } from "./period";

const IST_MS = 330 * 60 * 1000; // UTC+5:30, no DST

describe("periodStartsIst", () => {
  // 2026-07-14 09:00 IST (a Tuesday) = 03:30Z
  const now = Date.UTC(2026, 6, 14, 3, 30, 0);

  it("P.1 today starts at IST midnight (18:30Z the previous UTC day)", () => {
    expect(periodStartsIst(now).today).toBe(Date.UTC(2026, 6, 13, 18, 30, 0));
  });

  it("P.2 week starts Monday IST", () => {
    // 2026-07-13 is a Monday → week start = Mon 00:00 IST
    expect(periodStartsIst(now).week).toBe(Date.UTC(2026, 6, 12, 18, 30, 0));
  });

  it("P.3 month starts on the 1st IST, year on Jan 1 IST", () => {
    expect(periodStartsIst(now).month).toBe(Date.UTC(2026, 5, 30, 18, 30, 0));
    expect(periodStartsIst(now).year).toBe(Date.UTC(2025, 11, 31, 18, 30, 0));
  });

  it("P.4 late-UTC instants that are already the NEXT IST day roll forward", () => {
    // 2026-07-13 20:00Z = 2026-07-14 01:30 IST → "today" is still the 14th IST
    const lateUtc = Date.UTC(2026, 6, 13, 20, 0, 0);
    expect(periodStartsIst(lateUtc).today).toBe(Date.UTC(2026, 6, 13, 18, 30, 0));
  });

  it("P.5 boundaries are exact IST midnights", () => {
    const s = periodStartsIst(now);
    for (const t of [s.today, s.week, s.month, s.year]) {
      expect((t + IST_MS) % (24 * 60 * 60 * 1000)).toBe(0);
    }
  });
});
