// totalsSince — the admin dashboard's today / week / month / year rollups —
// and the billed-token columns (real Gemini usageMetadata counts) added
// 2026-07-14. Billed columns are SEPARATE from promptTokens/outputTokens:
// those stay char-estimates because the guest/daily gates are tuned to them.
// Uses an in-memory SQLite (no real .db file is ever touched — CLAUDE.md hard rule).
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteUsageStore } from "./db";

const geo = { ip: "203.0.113.9", country: null, region: null, city: null };

function ev(
  store: SqliteUsageStore,
  at: number,
  billed?: { billedPromptTokens: number; billedOutputTokens: number; thoughtTokens: number; cachedTokens: number },
) {
  vi.spyOn(Date, "now").mockReturnValue(at);
  store.record({
    userId: "user:a@x.com", userLabel: "Ann", model: "m", kind: "chat",
    promptTokens: 100, outputTokens: 50, costUsd: 0.01,
    geo, requestText: "q", outputText: "a", blocked: false,
    ...(billed ?? {}),
  });
  vi.restoreAllMocks();
}

describe("SqliteUsageStore — billed token columns + totalsSince", () => {
  const store = new SqliteUsageStore();
  const T0 = Date.UTC(2026, 6, 1, 10, 0, 0);

  beforeAll(() => {
    // Real usageMetadata counts attached (post-2026-07-14 rows).
    ev(store, T0, { billedPromptTokens: 3_000, billedOutputTokens: 800, thoughtTokens: 200, cachedTokens: 1_000 });
    // No billed counts supplied (stream died before usageMetadata / safety
    // call) → billed falls back to the estimate columns, thought/cached 0.
    ev(store, T0 + 1_000);
  });

  it("B.1 record round-trips all 4 billed token counts", () => {
    const [older] = store.listSince(0).slice(-1);
    const newest = store.listSince(0)[0]!;
    expect(store.listSince(0)).toHaveLength(2);
    // Oldest row (recorded first) carries the explicit billed counts.
    expect(older).toMatchObject({
      billedPromptTokens: 3_000, billedOutputTokens: 800, thoughtTokens: 200, cachedTokens: 1_000,
    });
    // Fallback row: billed mirrors the estimates so old-style records still count.
    expect(newest).toMatchObject({
      billedPromptTokens: 100, billedOutputTokens: 50, thoughtTokens: 0, cachedTokens: 0,
    });
  });

  it("B.2 totalsSince sums the billed counts + cost within the window", () => {
    const all = store.totalsSince(0);
    expect(all).toEqual({
      eventCount: 2,
      promptTokens: 3_100, outputTokens: 850, thoughtTokens: 200, cachedTokens: 1_000,
      costUsd: expect.closeTo(0.02, 10),
    });
  });

  it("B.3 totalsSince honors the window boundary", () => {
    const later = store.totalsSince(T0 + 500);
    expect(later.eventCount).toBe(1);
    expect(later.promptTokens).toBe(100);
  });

  it("B.4 an empty window is all zeros, not nulls", () => {
    const none = store.totalsSince(T0 + 999_999);
    expect(none).toEqual({
      eventCount: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0, costUsd: 0,
    });
  });

  it("B.5 summarizeSince byDay carries the 4 billed types", () => {
    const s = store.summarizeSince(0);
    expect(s.byDay[0]).toMatchObject({
      promptTokens: 3_100, outputTokens: 850, thoughtTokens: 200, cachedTokens: 1_000,
    });
    expect(s.totalThoughtTokens).toBe(200);
    expect(s.totalCachedTokens).toBe(1_000);
  });
});
