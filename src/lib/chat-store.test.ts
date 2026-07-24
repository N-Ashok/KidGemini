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

  // BUG-FIX-LOG 2026-07-13: the old hard 20-convo cap silently DELETED older
  // chats with no way to reach them. Only real storage quota may trim now.
  it("persists EVERY conversation — no arbitrary cap", () => {
    const s = fakeStorage();
    const many = Array.from({ length: 40 }, (_, i) => convo(`c${i}`));
    saveChats(s, many as never, "c0");
    expect(loadChats(s)!.convos.length).toBe(40);
    expect(loadChats(s)!.convos[0]!.id).toBe("c0");
  });

  it("on quota pressure drops the OLDEST conversations until it fits", () => {
    const s = fakeStorage();
    // ~200KB per convo; cap the store at ~1MB → only a handful fit.
    const limited = {
      ...s,
      setItem: (k: string, v: string) => {
        if (v.length > 1_000_000) throw new Error("QuotaExceededError");
        s.setItem(k, v);
      },
    } as Storage;
    const many = Array.from({ length: 40 }, (_, i) => convo(`c${i}`, true));
    saveChats(limited, many as never, "c0");
    const loaded = loadChats(s)!;
    expect(loaded.convos.length).toBeGreaterThan(0);
    expect(loaded.convos.length).toBeLessThan(40);
    // Newest-first head survives; the tail (oldest) was trimmed.
    expect(loaded.convos[0]!.id).toBe("c0");
  });

  it("the ACTIVE conversation survives quota trimming even from the tail", () => {
    const s = fakeStorage();
    const limited = {
      ...s,
      setItem: (k: string, v: string) => {
        if (v.length > 1_000_000) throw new Error("QuotaExceededError");
        s.setItem(k, v);
      },
    } as Storage;
    const many = Array.from({ length: 40 }, (_, i) => convo(`c${i}`, true));
    saveChats(limited, many as never, "c39"); // active is the OLDEST
    const loaded = loadChats(s)!;
    expect(loaded.convos.some((c) => c.id === "c39")).toBe(true);
    expect(loaded.activeId).toBe("c39");
  });

  // PRD-BIBLE-TEACHER: the teacher surface keeps its chats in a separate
  // bucket, so the two recents lists never bleed into each other on one device.
  it("isolates workspaces — bible-teacher chats are separate from the default app", () => {
    const s = fakeStorage();
    saveChats(s, [convo("kid1")] as never, "kid1"); // default workspace
    saveChats(s, [convo("bt1")] as never, "bt1", "bible-teacher");

    expect(loadChats(s)!.convos.map((c) => c.id)).toEqual(["kid1"]);
    expect(loadChats(s, "bible-teacher")!.convos.map((c) => c.id)).toEqual(["bt1"]);
  });

  it("the default workspace keeps the original storage key (no migration for existing devices)", () => {
    const s = fakeStorage();
    saveChats(s, [convo("a")] as never, "a"); // default
    expect(s.getItem("kidgemini:chats:v1")).toContain('"a"');
    expect(s.getItem("kidgemini:chats:v1:bible-teacher")).toBeNull();
  });

  // docs/PRD-IDEA-QUEUE-V2.md: ideas queued while Ari was building ride on the
  // conversation, so a reload mid-build finds the line exactly as it was. A
  // v1 row (no kind) loads back as a "build" — back-compat via sanitizeQueue.
  it("round-trips a chat's queued ideas, stamping v1 rows as builds", () => {
    const s = fakeStorage();
    const withQueue = { ...convo("a"), queuedIdeas: [{ id: "q1", text: "add a dragon boss", createdAt: 7 }] };
    saveChats(s, [withQueue] as never, "a");
    expect(loadChats(s)!.convos[0]!.queuedIdeas).toEqual([
      { id: "q1", text: "add a dragon boss", createdAt: 7, kind: "build" },
    ]);
  });

  it("drops a malformed queued idea instead of loading junk into the composer", () => {
    const s = fakeStorage();
    s.setItem(
      "kidgemini:chats:v1",
      JSON.stringify({ convos: [{ ...convo("a"), queuedIdeas: [{ id: "q1" }, "nope"] }], activeId: "a" }),
    );
    expect(loadChats(s)!.convos[0]!.queuedIdeas).toEqual([]);
  });

  it("degrades to null on corrupt data or quota errors (never throws)", () => {
    const s = fakeStorage();
    s.setItem("kidgemini:chats:v1", "{not json");
    expect(loadChats(s)).toBeNull();
    const throwing = { ...fakeStorage(), setItem: () => { throw new Error("quota"); } } as Storage;
    expect(() => saveChats(throwing, [convo("a")] as never, "a")).not.toThrow();
  });
});
