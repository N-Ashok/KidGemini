// Server-side chat history (TECH_DEBT #26): conversations keyed by account /
// guest cookie so chats survive cleared localStorage and follow the account.
// In-memory SQLite — no real .db file is ever touched (CLAUDE.md hard rule).
import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteChatHistoryStore } from "./db";
import type { Conversation } from "@/types/chat.types";

const convo = (id: string, title = `Chat ${id}`): Conversation => ({
  id,
  title,
  messages: [
    { id: `${id}-m1`, role: "child", text: "make me a game", createdAt: 1 },
    { id: `${id}-m2`, role: "assistant", text: "Here you go!", artifactHtml: "<html>game</html>", createdAt: 2 },
  ],
});

describe("SqliteChatHistoryStore", () => {
  const store = new SqliteChatHistoryStore();

  it("H.1 upserts and returns the full conversation (game HTML included) for its owner", () => {
    store.upsert("user:a@x.com", convo("c1"), 1000);
    const got = store.get("user:a@x.com", "c1")!;
    expect(got.title).toBe("Chat c1");
    expect(got.messages[1]!.artifactHtml).toBe("<html>game</html>");
  });

  it("H.2 ownership is fail-closed: another user can neither read nor overwrite", () => {
    store.upsert("user:a@x.com", convo("c2", "Mine"), 1000);
    expect(store.get("guest:g9", "c2")).toBeNull();
    // Overwrite attempt by a different identity is silently ignored.
    store.upsert("guest:g9", convo("c2", "Stolen"), 2000);
    expect(store.get("user:a@x.com", "c2")!.title).toBe("Mine");
  });

  it("H.3 lists summaries newest-first with cursor pagination (no message payloads)", () => {
    for (let i = 0; i < 5; i++) store.upsert("user:p@x.com", convo(`p${i}`), 1000 + i);
    const page1 = store.list("user:p@x.com", 2);
    expect(page1.map((s) => s.id)).toEqual(["p4", "p3"]);
    expect(page1[0]).not.toHaveProperty("messages");
    const page2 = store.list("user:p@x.com", 2, page1.at(-1)!);
    expect(page2.map((s) => s.id)).toEqual(["p2", "p1"]);
    const page3 = store.list("user:p@x.com", 2, page2.at(-1)!);
    expect(page3.map((s) => s.id)).toEqual(["p0"]);
  });

  it("H.3b same-millisecond rows are never skipped across pages (composite cursor)", () => {
    for (let i = 0; i < 5; i++) store.upsert("user:tie@x.com", convo(`t${i}`), 9999);
    const page1 = store.list("user:tie@x.com", 2);
    const page2 = store.list("user:tie@x.com", 2, page1.at(-1)!);
    const page3 = store.list("user:tie@x.com", 2, page2.at(-1)!);
    const all = [...page1, ...page2, ...page3].map((s) => s.id);
    expect(new Set(all).size).toBe(5);
  });

  it("H.4 list never leaks other identities' chats", () => {
    store.upsert("guest:g1", convo("g1c"), 5000);
    expect(store.list("guest:g1", 10).map((s) => s.id)).toEqual(["g1c"]);
  });

  it("H.5 bulkUpsert migrates a device's chats in one call and reports the count", () => {
    const n = store.bulkUpsert("user:m@x.com", [convo("m1"), convo("m2"), convo("m3")], 7000);
    expect(n).toBe(3);
    expect(store.list("user:m@x.com", 10)).toHaveLength(3);
    // Idempotent: re-running the migration doesn't duplicate.
    store.bulkUpsert("user:m@x.com", [convo("m1")], 8000);
    expect(store.list("user:m@x.com", 10)).toHaveLength(3);
  });

  it("H.6 upsert refreshes updatedAt so an old chat written to again floats to the top", () => {
    store.upsert("user:t@x.com", convo("t-old"), 1000);
    store.upsert("user:t@x.com", convo("t-new"), 2000);
    store.upsert("user:t@x.com", convo("t-old"), 3000);
    expect(store.list("user:t@x.com", 10)[0]!.id).toBe("t-old");
  });
});
