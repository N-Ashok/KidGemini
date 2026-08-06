// Rename/pin client-state transitions (owner ask 2026-08-06) — pure-reducer
// tests, same style as chat-delete.test.ts (CD.*).
import { describe, it, expect } from "vitest";
import { stateAfterRename, stateAfterPin, sortPinnedFirst } from "./chat-organize";
import type { Conversation } from "@/types/chat.types";
import type { ConvoSummary } from "@/types/chat-history.types";

const convo = (id: string, title = `Chat ${id}`): Conversation => ({
  id,
  title,
  messages: [{ id: `${id}-m`, role: "child", text: "hi", createdAt: 1 }],
});
const summary = (id: string, pinnedAt: number | null = null): ConvoSummary => ({
  id,
  title: `Chat ${id}`,
  updatedAt: 1,
  pinnedAt,
});

describe("stateAfterRename (CO.*)", () => {
  it("CO.1 renames in BOTH the local chats and the remote index; other rows untouched", () => {
    const r = stateAfterRename([convo("a"), convo("b")], [summary("a"), summary("c")], "a", "Dino plan");
    expect(r.convos.find((c) => c.id === "a")!.title).toBe("Dino plan");
    expect(r.convos.find((c) => c.id === "b")!.title).toBe("Chat b");
    expect(r.remoteIndex.find((s) => s.id === "a")!.title).toBe("Dino plan");
    expect(r.remoteIndex.find((s) => s.id === "c")!.title).toBe("Chat c");
  });

  it("CO.2 a server-only chat (not loaded locally) renames in the index alone, without error", () => {
    const r = stateAfterRename([convo("b")], [summary("remote-only")], "remote-only", "New name");
    expect(r.convos).toHaveLength(1);
    expect(r.remoteIndex[0]!.title).toBe("New name");
  });
});

describe("stateAfterPin (CO.*)", () => {
  it("CO.3 stamps pinnedAt in both collections; null unpins", () => {
    const pinned = stateAfterPin([convo("a")], [summary("a")], "a", 777);
    expect(pinned.convos[0]!.pinnedAt).toBe(777);
    expect(pinned.remoteIndex[0]!.pinnedAt).toBe(777);
    const unpinned = stateAfterPin(pinned.convos, pinned.remoteIndex, "a", null);
    expect(unpinned.convos[0]!.pinnedAt).toBeNull();
    expect(unpinned.remoteIndex[0]!.pinnedAt).toBeNull();
  });
});

describe("sortPinnedFirst (CO.*)", () => {
  it("CO.4 pinned rows float to the top, most recently pinned first; unpinned keep their order", () => {
    const rows = [
      { id: "u1", pinnedAt: null },
      { id: "p-old", pinnedAt: 100 },
      { id: "u2" },
      { id: "p-new", pinnedAt: 200 },
      { id: "u3", pinnedAt: null },
    ];
    expect(sortPinnedFirst(rows).map((r) => r.id)).toEqual(["p-new", "p-old", "u1", "u2", "u3"]);
  });

  it("CO.5 with nothing pinned the list is unchanged (recency order intact)", () => {
    const rows: Array<{ id: string; pinnedAt?: number | null }> = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(sortPinnedFirst(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
