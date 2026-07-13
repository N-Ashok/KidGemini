import { describe, it, expect } from "vitest";
import { mergeRecents, appendPage } from "./chat-sync";

const s = (id: string, title = `Chat ${id}`, updatedAt = 1) => ({ id, title, updatedAt });

describe("chat-sync — sidebar merge", () => {
  it("appends server-only chats after the device's, deduped by id", () => {
    const merged = mergeRecents([{ id: "a", title: "Local A" }], [s("a", "Server A"), s("b", "Server B")], "");
    expect(merged).toEqual([
      { id: "a", title: "Local A" }, // local copy wins (it may be newer, unsynced)
      { id: "b", title: "Server B" },
    ]);
  });

  it("search filters server-only entries by title (their messages aren't on-device)", () => {
    const merged = mergeRecents([], [s("b", "Maze game"), s("c", "Space chat")], "maze");
    expect(merged.map((r) => r.id)).toEqual(["b"]);
  });

  it("appendPage dedupes a chat that moved pages between fetches", () => {
    const out = appendPage([s("a"), s("b")], [s("b"), s("c")]);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
