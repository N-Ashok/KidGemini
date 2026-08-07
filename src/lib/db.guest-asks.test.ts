// Owner funnel decision 2026-08-08: a signed-out visitor gets exactly ONE ask
// — the game builds (preview locked behind sign-in), and the SECOND ask hits
// the sign-in wall. The gate needs an ask COUNT, not a token tally: tokens
// undercounted real usage ~13× (visible text vs. the real prompt+thinking) and
// a per-ask rule is what the owner actually wants ("just the first ask").
// In-memory SQLite only (no real .db file — CLAUDE.md hard rule).
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteUsageStore } from "./db";

const geo = { ip: "203.0.113.7", country: null, region: null, city: null };

function ev(
  store: SqliteUsageStore,
  userId: string,
  kind: "chat" | "safety" | "repair" | "fallback",
  opts: { blocked?: boolean; at?: number } = {},
) {
  store.record({
    userId, userLabel: null, model: "m", kind,
    promptTokens: 100, outputTokens: 100, costUsd: 0.001,
    geo, requestText: "q", outputText: "a", blocked: opts.blocked ?? false,
  });
}

describe("chatTurnsByUser — the guest one-ask gate's counter", () => {
  it("counts only real chat turns: safety screens, repairs, and losing fallback calls are not asks", () => {
    const store = new SqliteUsageStore();
    ev(store, "guest:g1", "chat");
    ev(store, "guest:g1", "safety");
    ev(store, "guest:g1", "repair");
    ev(store, "guest:g1", "fallback");
    expect(store.chatTurnsByUser("guest:g1")).toBe(1);
  });

  it("a BLOCKED chat turn does not burn the one free ask — a safety redirect on the first message must not wall a kid who never built anything", () => {
    const store = new SqliteUsageStore();
    ev(store, "guest:g2", "chat", { blocked: true });
    expect(store.chatTurnsByUser("guest:g2")).toBe(0);
    ev(store, "guest:g2", "chat");
    expect(store.chatTurnsByUser("guest:g2")).toBe(1);
  });

  it("scoped per user and windowed by sinceMs (the rolling 2-day reset)", () => {
    const store = new SqliteUsageStore();
    ev(store, "guest:g3", "chat");
    ev(store, "guest:other", "chat");
    expect(store.chatTurnsByUser("guest:g3")).toBe(1);
    expect(store.chatTurnsByUser("guest:g3", Date.now() + 60_000)).toBe(0); // everything older than the window
  });
});
