// Self-healing preview §12 — decision (2026-07-10): repair calls are EXEMPT
// from the guest/daily token gates. The kid didn't ask for the bug, so two
// failed repairs must not burn their trial. Repair usage is still RECORDED
// (kind:"repair") so the admin dashboard keeps full cost visibility.
// Uses an in-memory SQLite (no real .db file is ever touched — CLAUDE.md hard rule).
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteUsageStore } from "./db";

const geo = { ip: "203.0.113.9", country: null, region: null, city: null };

function ev(store: SqliteUsageStore, userId: string, kind: "chat" | "safety" | "repair", tokens: number) {
  store.record({
    userId, userLabel: null, model: "m", kind,
    promptTokens: tokens, outputTokens: 0, costUsd: 0,
    geo, requestText: "q", outputText: "a", blocked: false,
  });
}

describe("repair usage is exempt from every gate tally", () => {
  const store = new SqliteUsageStore();
  ev(store, "guest:g9", "chat", 1_000);
  ev(store, "guest:g9", "safety", 200);
  ev(store, "guest:g9", "repair", 50_000); // huge repair spend must not gate

  it("tokensUsedByUser (guest gate) ignores kind:repair", () => {
    expect(store.tokensUsedByUser("guest:g9")).toBe(1_200);
  });

  it("guestTokensUsedByIp (cookie-clearing backstop) ignores kind:repair", () => {
    expect(store.guestTokensUsedByIp("203.0.113.9")).toBe(1_200);
  });

  it("tokensUsedByUserSince (signed-in daily budget) ignores kind:repair", () => {
    expect(store.tokensUsedByUserSince("guest:g9", 0)).toBe(1_200);
  });

  it("repair events stay visible to the admin dashboard (cost observability)", () => {
    const s = store.summarizeSince(0);
    expect(s.totalPromptTokens).toBe(51_200);
    expect(store.listSince(0).some((e) => e.kind === "repair")).toBe(true);
  });
});
