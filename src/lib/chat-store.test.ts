import { describe, it, expect } from "vitest";
import { saveChats, loadChats } from "./chat-store";

/** BUG-FIX-LOG 2026-07-07: navigating away (e.g. sign-in round trip, Studio
 *  link) lost the whole chat — conversations lived only in React state. */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
}

const convo = (id: string, big = false) => ({
  id,
  title: `Chat ${id}`,
  messages: [{ id: "m1", role: "assistant", text: big ? "x".repeat(200_000) : "hi", createdAt: 1 }],
});

describe("chat-store — chats survive navigation", () => {
  it("round-trips conversations and the active id", () => {
    const s = fakeStorage();
    saveChats(s, [convo("a"), convo("b")] as never, "b");
    const loaded = loadChats(s)!;
    expect(loaded.convos.map((c) => c.id)).toEqual(["a", "b"]);
    expect(loaded.activeId).toBe("b");
  });

  it("caps stored conversations (newest-first list keeps its head)", () => {
    const s = fakeStorage();
    const many = Array.from({ length: 40 }, (_, i) => convo(`c${i}`));
    saveChats(s, many as never, "c0");
    expect(loadChats(s)!.convos.length).toBeLessThanOrEqual(20);
    expect(loadChats(s)!.convos[0]!.id).toBe("c0");
  });

  it("degrades to null on corrupt data or quota errors (never throws)", () => {
    const s = fakeStorage();
    s.setItem("kidgemini:chats:v1", "{not json");
    expect(loadChats(s)).toBeNull();
    const throwing = { ...fakeStorage(), setItem: () => { throw new Error("quota"); } } as Storage;
    expect(() => saveChats(throwing, [convo("a")] as never, "a")).not.toThrow();
  });
});
