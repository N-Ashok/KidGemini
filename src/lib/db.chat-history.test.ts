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

  it("H.7 claim reassigns every row from a guest identity to the account (guest→account merge gap)", () => {
    store.upsert("guest:claim1", convo("cl1"), 1000);
    store.upsert("guest:claim1", convo("cl2"), 2000);
    const n = store.claim("guest:claim1", "user:claim@x.com");
    expect(n).toBe(2);
    expect(store.list("guest:claim1", 10)).toEqual([]);
    expect(store.list("user:claim@x.com", 10).map((s) => s.id).sort()).toEqual(["cl1", "cl2"]);
  });

  it("H.8 claim leaves the account's own pre-existing chats untouched", () => {
    store.upsert("user:coll@x.com", convo("acct1", "Account's own"), 1000);
    store.upsert("guest:claim2", convo("g1"), 2000);
    const n = store.claim("guest:claim2", "user:coll@x.com");
    expect(n).toBe(1); // only the guest row moved
    expect(store.get("user:coll@x.com", "acct1")!.title).toBe("Account's own");
    expect(store.list("user:coll@x.com", 10).map((s) => s.id).sort()).toEqual(["acct1", "g1"]);
  });

  it("H.9 claim is a no-op when there is nothing to claim, or from === to", () => {
    expect(store.claim("guest:never-existed", "user:new@x.com")).toBe(0);
    expect(store.claim("user:new@x.com", "user:new@x.com")).toBe(0);
  });

  // PRD-BIBLE-TEACHER: the same account has two separate recents lists — the
  // list() query must be scoped by workspace so a teacher chat never shows up
  // in the kid app and vice versa.
  it("H.10 list is scoped by workspace — teacher and default chats never cross", () => {
    const uid = "user:ws@x.com";
    store.upsert(uid, convo("kidchat"), 1000); // no workspace → 'default'
    store.upsert(uid, { ...convo("btchat"), workspace: "bible-teacher" }, 2000);

    expect(store.list(uid, 10).map((s) => s.id)).toEqual(["kidchat"]); // default (implicit)
    expect(store.list(uid, 10, undefined, "default").map((s) => s.id)).toEqual(["kidchat"]);
    expect(store.list(uid, 10, undefined, "bible-teacher").map((s) => s.id)).toEqual(["btchat"]);
  });

  it("H.11 a bible-teacher conversation round-trips its workspace through get()", () => {
    store.upsert("user:rt@x.com", { ...convo("rt1"), workspace: "bible-teacher" }, 1000);
    expect(store.get("user:rt@x.com", "rt1")!.workspace).toBe("bible-teacher");
    // A default chat carries no workspace field (kept clean).
    store.upsert("user:rt@x.com", convo("rt2"), 1000);
    expect(store.get("user:rt@x.com", "rt2")!.workspace).toBeUndefined();
  });
});
