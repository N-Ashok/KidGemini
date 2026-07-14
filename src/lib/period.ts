// IST calendar-period boundaries for the admin dashboard rollups (today /
// this week / this month / this year). The operator runs the business in
// India, so "today" means the IST day — not UTC (which flips at 5:30 AM IST).
// IST is a fixed UTC+5:30 with no DST, so plain offset math is exact.

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PeriodStarts {
  /** IST midnight of the current IST day, as a UTC epoch-ms. */
  today: number;
  /** IST midnight of the most recent Monday. */
  week: number;
  /** IST midnight of the 1st of the current IST month. */
  month: number;
  /** IST midnight of Jan 1 of the current IST year. */
  year: number;
}

export function periodStartsIst(nowMs: number): PeriodStarts {
  const ist = new Date(nowMs + IST_OFFSET_MS); // read its UTC fields as IST wall-clock
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const today = Date.UTC(y, m, d) - IST_OFFSET_MS;
  const daysSinceMonday = (ist.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return {
    today,
    week: today - daysSinceMonday * DAY_MS,
    month: Date.UTC(y, m, 1) - IST_OFFSET_MS,
    year: Date.UTC(y, 0, 1) - IST_OFFSET_MS,
  };
}
