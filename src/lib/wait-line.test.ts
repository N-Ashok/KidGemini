import { describe, it, expect } from "vitest";
import { waitLine } from "./wait-line";
import { savePendingTurn, loadPendingTurn, clearPendingTurn } from "./pending-turn";

describe("waitLine — escalating kid-facing wait status", () => {
  it("starts with the default (null), then escalates and never freezes", () => {
    expect(waitLine(0)).toBeNull();
    expect(waitLine(11_000)).toBeNull();
    expect(waitLine(15_000)).toContain("🧱");
    expect(waitLine(35_000)).toContain("faster helper");
    expect(waitLine(70_000)).toContain("hang tight");
    expect(waitLine(500_000)).toContain("🦖");
  });
});

describe("pending-turn — tab-close recovery bookmark", () => {
  const fakeStorage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as Storage;
  };

  it("round-trips and clears", () => {
    const s = fakeStorage();
    savePendingTurn(s, { replyId: "r1", convoId: "c1", startedAt: 1000 });
    expect(loadPendingTurn(s, 2000)).toMatchObject({ replyId: "r1", convoId: "c1" });
    clearPendingTurn(s);
    expect(loadPendingTurn(s, 2000)).toBeNull();
  });

  it("expires with the server's 24h turn_results TTL", () => {
    const s = fakeStorage();
    savePendingTurn(s, { replyId: "r1", convoId: "c1", startedAt: 0 });
    expect(loadPendingTurn(s, 23 * 60 * 60 * 1000)).not.toBeNull();
    expect(loadPendingTurn(s, 25 * 60 * 60 * 1000)).toBeNull();
  });

  it("never throws on corrupt data", () => {
    const s = fakeStorage();
    s.setItem("kidgemini:pending-turn:v1", "{not json");
    expect(loadPendingTurn(s)).toBeNull();
  });
});
