// Usage/cost rollup builder — pure query logic extracted from
// `api/usage/route.ts` (2026-07-28, Feature 5 admin consolidation) so both
// the legacy browser-facing route (ADMIN_SECRET) and the new server-to-server
// bridge (`api/admin/usage-bridge`, x-admin-secret, called by Platform's
// `/studio/admin` Usage tab) compute identical rollups from one place. This
// module owns no auth — callers gate access before calling `buildUsageReport`.

import { SqliteUsageStore } from "./db";
import { periodStartsIst } from "./period";
import { inrPerUsd } from "./pricing.config";
import type {
  PeriodTotals,
  RepeatUser,
  UniqueCounts,
  UsageEvent,
  UsageSummary,
} from "@/types/usage.types";

const DAY_MS = 24 * 60 * 60 * 1000;

const usage = new SqliteUsageStore();

export type PeriodKey = "today" | "thisWeek" | "thisMonth" | "thisYear" | "allTime";
export type PeriodWithInr = PeriodTotals & { costInr: number };

export interface UsageReport {
  days: number;
  inrPerUsd: number;
  periods: Record<PeriodKey, PeriodWithInr>;
  uniques: Record<PeriodKey, UniqueCounts>;
  repeatUsers: RepeatUser[];
  summary: UsageSummary;
  events?: UsageEvent[];
}

/** Same rollup shape /api/usage has always returned — `days` in the response
 *  is the raw parsed input (unclamped), matching the pre-extraction route. */
export function buildUsageReport(opts: { days?: unknown; detail?: unknown }): UsageReport {
  const days = Number(opts.days ?? 30);
  const since = Date.now() - (Number.isFinite(days) && days > 0 ? days : 30) * DAY_MS;

  // Rollup cards: IST calendar periods (the operator's day, not UTC) + all
  // time. ₹ derives from stored USD at the current USD_INR_RATE at read time.
  const rate = inrPerUsd();
  const starts = periodStartsIst(Date.now());
  const withInr = (t: PeriodTotals) => ({ ...t, costInr: t.costUsd * rate });
  const periods: Record<PeriodKey, PeriodWithInr> = {
    today: withInr(usage.totalsSince(starts.today)),
    thisWeek: withInr(usage.totalsSince(starts.week)),
    thisMonth: withInr(usage.totalsSince(starts.month)),
    thisYear: withInr(usage.totalsSince(starts.year)),
    allTime: withInr(usage.totalsSince(0)),
  };
  // Distinct visitors per window: accounts + guest cookies + guest (ip, UA)
  // devices — three imperfect signals shown side by side (see UniqueCounts).
  const uniques: Record<PeriodKey, UniqueCounts> = {
    today: usage.uniquesSince(starts.today),
    thisWeek: usage.uniquesSince(starts.week),
    thisMonth: usage.uniquesSince(starts.month),
    thisYear: usage.uniquesSince(starts.year),
    allTime: usage.uniquesSince(0),
  };

  // All-time on purpose: "who keeps coming back" is a retention question,
  // not a window question (the per-day table already covers the window).
  const repeatUsers = usage.repeatUsersSince(0);

  const summary = usage.summarizeSince(since);
  const events = opts.detail === true ? usage.listSince(since) : undefined;

  return { days, inrPerUsd: rate, periods, uniques, repeatUsers, summary, events };
}
