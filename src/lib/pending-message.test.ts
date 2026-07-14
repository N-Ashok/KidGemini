// Auth-interruption recovery (BUG-FIX-LOG 2026-07-14): a 401 gate mid-turn used
// to abandon the kid's message entirely — they had to retype after signing in,
// which read as "the chat died." Same never-throw contract as pending-turn.ts.
import { describe, it, expect } from "vitest";
import { savePendingMessage, loadPendingMessage, clearPendingMessage } from "./pending-message";

function fakeStorage(init: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(init));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("pending-message — round-trip", () => {
  it("saves and loads back the same message", () => {
    const s = fakeStorage();
    savePendingMessage(s, { text: "make the dino purple", convoId: "c1", savedAt: 1000 });
    expect(loadPendingMessage(s, 1000)).toEqual({ text: "make the dino purple", convoId: "c1", savedAt: 1000 });
  });

  it("clear removes it", () => {
    const s = fakeStorage();
    savePendingMessage(s, { text: "hi", convoId: "c1", savedAt: 1000 });
    clearPendingMessage(s);
    expect(loadPendingMessage(s, 1000)).toBeNull();
  });

  it("nothing saved → null", () => {
    expect(loadPendingMessage(fakeStorage())).toBeNull();
  });
});

describe("pending-message — TTL (10 min: resume a keystroke, not a generation)", () => {
  it("still valid just under 10 minutes later", () => {
    const s = fakeStorage();
    savePendingMessage(s, { text: "hi", convoId: "c1", savedAt: 0 });
    expect(loadPendingMessage(s, 10 * 60 * 1000 - 1)).not.toBeNull();
  });

  it("expired just past 10 minutes", () => {
    const s = fakeStorage();
    savePendingMessage(s, { text: "hi", convoId: "c1", savedAt: 0 });
    expect(loadPendingMessage(s, 10 * 60 * 1000 + 1)).toBeNull();
  });
});

describe("pending-message — never throws, never returns garbage", () => {
  it("save never throws (quota / private mode)", () => {
    const s = fakeStorage();
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => savePendingMessage(s, { text: "hi", convoId: "c1", savedAt: 0 })).not.toThrow();
  });

  it("clear never throws", () => {
    const s = fakeStorage();
    s.removeItem = () => {
      throw new Error("boom");
    };
    expect(() => clearPendingMessage(s)).not.toThrow();
  });

  it("malformed JSON is treated as absent", () => {
    expect(loadPendingMessage(fakeStorage({ "kidgemini:pending-message:v1": "{not json" }))).toBeNull();
  });

  it("missing/wrong-typed fields are treated as absent", () => {
    expect(loadPendingMessage(fakeStorage({ "kidgemini:pending-message:v1": JSON.stringify({ text: "hi" }) }))).toBeNull();
    expect(
      loadPendingMessage(fakeStorage({ "kidgemini:pending-message:v1": JSON.stringify({ text: "", convoId: "c1", savedAt: 0 }) })),
    ).toBeNull(); // an empty message is nothing to resume
  });
});
