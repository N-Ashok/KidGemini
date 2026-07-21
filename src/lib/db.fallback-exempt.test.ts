// Owner ask 2026-07-21: a LOSING model call from a fan-out (a one-shot backup
// that finished after the winner) is real spend we incurred, so it is RECORDED
// (kind:"fallback") and COUNTED IN THE DASHBOARD COST — but, exactly like
// repair, EXEMPT from the child's guest/daily token gates: our race waste is
// not the child's request. Mirrors db.repair-exempt.test.ts.
// In-memory SQLite only (no real .db file — CLAUDE.md hard rule).
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteUsageStore } from "./db";

const geo = { ip: "203.0.113.7", country: null, region: null, city: null };

function ev(store: SqliteUsageStore, userId: string, kind: "chat" | "safety" | "repair" | "fallback", tokens: number, costUsd = 0) {
  store.record({
    userId, userLabel: null, model: "m", kind,
    promptTokens: tokens, outputTokens: 0, costUsd,
    geo, requestText: "q", outputText: "a", blocked: false,
  });
}

describe("fallback (losing-call) usage is exempt from every gate tally but counts as cost", () => {
  const store = new SqliteUsageStore();
  ev(store, "guest:g7", "chat", 1_000, 0.01);
  ev(store, "guest:g7", "safety", 200, 0);
  ev(store, "guest:g7", "fallback", 40_000, 0.20); // a big losing build must NOT gate the child

  it("tokensUsedByUser (guest gate) ignores kind:fallback", () => {
    expect(store.tokensUsedByUser("guest:g7")).toBe(1_200);
  });

  it("guestTokensUsedByIp (cookie-clearing backstop) ignores kind:fallback", () => {
    expect(store.guestTokensUsedByIp("203.0.113.7")).toBe(1_200);
  });

  it("tokensUsedByUserSince (signed-in daily budget) ignores kind:fallback", () => {
    expect(store.tokensUsedByUserSince("guest:g7", 0)).toBe(1_200);
  });

  it("fallback cost IS added to the dashboard total (the whole point)", () => {
    const s = store.summarizeSince(0);
    expect(s.totalPromptTokens).toBe(41_200); // 1000 + 200 + 40000
    expect(s.totalCostUsd).toBeCloseTo(0.21); // 0.01 + 0 + 0.20 — loser cost included
    expect(store.listSince(0).some((e) => e.kind === "fallback")).toBe(true);
  });
});
