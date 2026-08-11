// Server-side chat history (TECH_DEBT #26): conversations keyed by account /
// guest cookie so chats survive cleared localStorage and follow the account.
// In-memory SQLite — no real .db file is ever touched (CLAUDE.md hard rule).
import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteChatHistoryStore, SqliteGameSaveStore, getDb } from "./db";
import type { Conversation } from "@/types/chat.types";
import type { GameSaveState } from "@/types/game-save.types";

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

  // ── Soft delete (owner ask 2026-07-26): removed from the ACCOUNT'S VIEW
  //    (list + get), never from the system — the row stays for safety review
  //    and recoverability. ──────────────────────────────────────────────────
  it("H.12 softDelete hides the chat from list() and get(), and reports true", () => {
    const uid = "user:del@x.com";
    store.upsert(uid, convo("d1"), 1000);
    store.upsert(uid, convo("d2"), 2000);
    expect(store.softDelete(uid, "d1", 3000)).toBe(true);
    expect(store.list(uid, 10).map((s) => s.id)).toEqual(["d2"]);
    expect(store.get(uid, "d1")).toBeNull();
    expect(store.get(uid, "d2")).not.toBeNull();
  });

  it("H.13 softDelete is fail-closed on ownership: a foreign or unknown id is a no-op returning false", () => {
    store.upsert("user:owner@x.com", convo("d3"), 1000);
    expect(store.softDelete("guest:g1", "d3", 2000)).toBe(false); // someone else's chat
    expect(store.softDelete("user:owner@x.com", "nope", 2000)).toBe(false); // unknown id
    expect(store.list("user:owner@x.com", 10).map((s) => s.id)).toContain("d3"); // untouched
  });

  it("H.14 a later upsert of a deleted chat does NOT resurrect it in the account's view", () => {
    const uid = "user:zombie@x.com";
    store.upsert(uid, convo("d4"), 1000);
    store.softDelete(uid, "d4", 2000);
    // Another device still holding the chat locally re-syncs it (write-through PUT).
    store.upsert(uid, convo("d4", "Re-synced"), 3000);
    expect(store.list(uid, 10).map((s) => s.id)).not.toContain("d4");
    expect(store.get(uid, "d4")).toBeNull();
  });

  it("H.15 deleting twice is idempotent — the second call reports false", () => {
    const uid = "user:twice@x.com";
    store.upsert(uid, convo("d5"), 1000);
    expect(store.softDelete(uid, "d5", 2000)).toBe(true);
    expect(store.softDelete(uid, "d5", 3000)).toBe(false);
  });

  // ── Cascade into game_saves on soft delete (docs/SCALABILITY_ISSUES.md #8,
  //    docs/2026-08-01_PRD_SaveContinueBuilding.md §6) — landed with the save
  //    feature going live, not deferred to a later phase. ──────────────────
  it("H.16 softDelete cascades into game_saves — a deleted conversation's save rows are gone", () => {
    const uid = "user:cascade@x.com";
    const gameSaves = new SqliteGameSaveStore();
    const state: GameSaveState = { areas: [{ id: "a", originX: 0, originZ: 0, objects: [] }] };
    store.upsert(uid, convo("d6"), 1000);
    gameSaves.upsert(uid, { conversationId: "d6", messageId: "d6-m2", state }, 1000);
    expect(gameSaves.get(uid, "d6-m2")).not.toBeNull();

    expect(store.softDelete(uid, "d6", 2000)).toBe(true);
    expect(gameSaves.get(uid, "d6-m2")).toBeNull();
  });

  it("H.17 a foreign/unknown id's softDelete no-op leaves game_saves untouched (no cascade fires)", () => {
    const uid = "user:cascade2@x.com";
    const gameSaves = new SqliteGameSaveStore();
    const state: GameSaveState = { areas: [{ id: "a", originX: 0, originZ: 0, objects: [] }] };
    store.upsert(uid, convo("d7"), 1000);
    gameSaves.upsert(uid, { conversationId: "d7", messageId: "d7-m2", state }, 1000);

    expect(store.softDelete("user:thief@x.com", "d7", 2000)).toBe(false);
    expect(gameSaves.get(uid, "d7-m2")).not.toBeNull(); // untouched
  });

  it("H.18 the cascade is DI'd through the constructor — a fake GameSaveStore is called with the right conversation id", () => {
    const calls: string[] = [];
    const fakeGameSaves = {
      upsert: () => true,
      get: () => null,
      deleteByConversation: (conversationId: string) => {
        calls.push(conversationId);
        return 0;
      },
    };
    const storeWithFake = new SqliteChatHistoryStore(fakeGameSaves);
    storeWithFake.upsert("user:di@x.com", convo("d8"), 1000);
    storeWithFake.softDelete("user:di@x.com", "d8", 2000);
    expect(calls).toEqual(["d8"]);
  });

  // Rename + pin (owner ask 2026-08-06: the sidebar's ⋮ menu). Rename must
  // NOT bump recency — a title fix on an old chat shouldn't catapult it to
  // the top of Recents; pinning is its own field the client sorts on.
  it("H.19 rename updates the title without touching recency", () => {
    store.upsert("user:rn@x.com", convo("r1"), 1000);
    store.upsert("user:rn@x.com", convo("r2"), 2000);
    expect(store.rename("user:rn@x.com", "r1", "Dino ideas")).toBe(true);
    expect(store.get("user:rn@x.com", "r1")!.title).toBe("Dino ideas");
    expect(store.list("user:rn@x.com", 10).map((s) => s.id)).toEqual(["r2", "r1"]);
  });

  it("H.20 rename is fail-closed: foreign, unknown, and soft-deleted ids all return false unchanged", () => {
    store.upsert("user:rn2@x.com", convo("r3", "Mine"), 1000);
    expect(store.rename("guest:thief", "r3", "Stolen")).toBe(false);
    expect(store.rename("user:rn2@x.com", "nope", "Ghost")).toBe(false);
    store.softDelete("user:rn2@x.com", "r3", 2000);
    expect(store.rename("user:rn2@x.com", "r3", "Zombie")).toBe(false);
    // the row itself kept its pre-delete title (system copy untouched)
  });

  it("H.21 setPinned round-trips into list() summaries; unpin clears it", () => {
    store.upsert("user:pin@x.com", convo("pn1"), 1000);
    store.upsert("user:pin@x.com", convo("pn2"), 2000);
    expect(store.setPinned("user:pin@x.com", "pn1", true, 5000)).toBe(true);
    const rows = store.list("user:pin@x.com", 10);
    expect(rows.find((s) => s.id === "pn1")!.pinnedAt).toBe(5000);
    expect(rows.find((s) => s.id === "pn2")!.pinnedAt).toBeNull();
    expect(store.setPinned("user:pin@x.com", "pn1", false, 6000)).toBe(true);
    expect(store.list("user:pin@x.com", 10).find((s) => s.id === "pn1")!.pinnedAt).toBeNull();
  });

  it("H.22 setPinned is fail-closed: foreign, unknown, and soft-deleted ids all return false", () => {
    store.upsert("user:pin2@x.com", convo("pn3"), 1000);
    expect(store.setPinned("guest:thief", "pn3", true, 5000)).toBe(false);
    expect(store.setPinned("user:pin2@x.com", "nope", true, 5000)).toBe(false);
    store.softDelete("user:pin2@x.com", "pn3", 2000);
    expect(store.setPinned("user:pin2@x.com", "pn3", true, 5000)).toBe(false);
  });

  // Share link (2026-08-06_PRD_ShareConversation.md): the public read is the
  // ONLY unauthenticated query on this table — these pin its whole contract.
  it("H.23 share token round-trips: set → public read by token alone; owner sees the live token", () => {
    store.upsert("user:sh@x.com", convo("s1", "Shared chat"), 1000);
    expect(store.setShareToken("user:sh@x.com", "s1", "tok-abc")).toBe(true);
    expect(store.getShareToken("user:sh@x.com", "s1")).toEqual({ shareToken: "tok-abc" });
    const pub = store.getSharedByToken("tok-abc")!;
    expect(pub.title).toBe("Shared chat");
    expect(pub.messages[0]!.text).toBe("make me a game");
  });

  it("H.24 revoke (token → null) kills the public read; owner state shows unshared", () => {
    store.upsert("user:sh2@x.com", convo("s2"), 1000);
    store.setShareToken("user:sh2@x.com", "s2", "tok-live");
    expect(store.setShareToken("user:sh2@x.com", "s2", null)).toBe(true);
    expect(store.getSharedByToken("tok-live")).toBeNull();
    expect(store.getShareToken("user:sh2@x.com", "s2")).toEqual({ shareToken: null });
  });

  it("H.25 share writes are fail-closed: foreign, unknown, and soft-deleted ids all refuse", () => {
    store.upsert("user:sh3@x.com", convo("s3"), 1000);
    expect(store.setShareToken("guest:thief", "s3", "tok-steal")).toBe(false);
    expect(store.getShareToken("guest:thief", "s3")).toBeNull();
    expect(store.setShareToken("user:sh3@x.com", "nope", "tok-x")).toBe(false);
    store.softDelete("user:sh3@x.com", "s3", 2000);
    expect(store.setShareToken("user:sh3@x.com", "s3", "tok-late")).toBe(false);
  });

  it("H.26 soft-deleting a SHARED chat makes its live link dead (page dies with the chat)", () => {
    store.upsert("user:sh4@x.com", convo("s4"), 1000);
    store.setShareToken("user:sh4@x.com", "s4", "tok-dies");
    expect(store.getSharedByToken("tok-dies")).not.toBeNull();
    store.softDelete("user:sh4@x.com", "s4", 2000);
    expect(store.getSharedByToken("tok-dies")).toBeNull();
    // empty/unknown tokens are a plain miss, never an oracle
    expect(store.getSharedByToken("")).toBeNull();
    expect(store.getSharedByToken("tok-unknown")).toBeNull();
  });

  // ── The scalable follow-up to the 2026-08-11 chat-history size-cap
  // incident (owner decision): upsert splits old artifacts into their own
  // table instead of leaving the conversations row to grow forever.
  it("H.27 an old artifact past the inline budget is externalized on save, not lost", () => {
    const bigMsg = (id: string, kb: number) =>
      ({ id, role: "assistant" as const, text: "game", artifactHtml: "x".repeat(kb * 1024), createdAt: 1 });
    const long: Conversation = {
      id: "long1",
      title: "Long session",
      messages: Array.from({ length: 20 }, (_, i) => bigMsg(`m${i}`, 200)), // 4MB, 2x the 2MB budget
    };
    store.upsert("user:long@x.com", long, 1000);
    const got = store.get("user:long@x.com", "long1")!;
    // The newest message stays inline...
    expect(got.messages.at(-1)!.artifactHtml).toBeDefined();
    // ...an old one is externalized, not silently dropped from the row.
    const old = got.messages[0]!;
    expect(old.artifactHtml).toBeUndefined();
    expect(old.artifactExternal).toBe(true);
    // ...and its real content is still fetchable.
    expect(store.getMessageArtifact("user:long@x.com", "long1", old.id)).toBe("x".repeat(200 * 1024));
    // The STORED row itself is now bounded near the budget (~2MB of inline
    // artifact bytes, plus small per-message JSON overhead for all 20
    // messages) — nowhere near the full 4MB the un-trimmed conversation
    // would have been, which is what actually removes the wall.
    const row = getDb()
      .prepare("SELECT length(messages) AS n FROM conversations WHERE id = ?")
      .get("long1") as { n: number };
    expect(row.n).toBeLessThan(2_500_000);
  });

  it("H.28 getMessageArtifact is fail-closed on ownership, same as get()", () => {
    const withArtifact: Conversation = {
      id: "own1",
      title: "t",
      messages: Array.from({ length: 15 }, (_, i) => ({
        id: `m${i}`, role: "assistant" as const, text: "g", artifactHtml: "x".repeat(200 * 1024), createdAt: 1,
      })),
    };
    store.upsert("user:owner@x.com", withArtifact, 1000);
    const externalized = store.get("user:owner@x.com", "own1")!.messages.find((m) => m.artifactExternal)!;
    expect(store.getMessageArtifact("guest:thief", "own1", externalized.id)).toBeNull();
    expect(store.getMessageArtifact("user:owner@x.com", "own1", externalized.id)).not.toBeNull();
    // An unknown messageId under a conversation the caller DOES own is a
    // plain miss, never an error.
    expect(store.getMessageArtifact("user:owner@x.com", "own1", "no-such-message")).toBeNull();
  });

  it("H.29 re-saving the same long conversation doesn't duplicate or corrupt externalized rows (idempotent)", () => {
    const bigMsg = (id: string, kb: number) =>
      ({ id, role: "assistant" as const, text: "game", artifactHtml: "x".repeat(kb * 1024), createdAt: 1 });
    const long: Conversation = {
      id: "long2",
      title: "v1",
      messages: Array.from({ length: 20 }, (_, i) => bigMsg(`n${i}`, 200)),
    };
    store.upsert("user:re@x.com", long, 1000);
    // The client always sends full history again on the NEXT save (it has
    // no concept of externalization) — this must settle cleanly, not error
    // or grow message_artifacts unboundedly.
    store.upsert("user:re@x.com", { ...long, title: "v2" }, 2000);
    const got = store.get("user:re@x.com", "long2")!;
    expect(got.title).toBe("v2");
    const old = got.messages[0]!;
    expect(store.getMessageArtifact("user:re@x.com", "long2", old.id)).toBe("x".repeat(200 * 1024));
  });

  it("H.30 a small conversation is unaffected — no message_artifacts rows created", () => {
    store.upsert("user:small@x.com", convo("small1"), 1000);
    const got = store.get("user:small@x.com", "small1")!;
    expect(got.messages.every((m) => !m.artifactExternal)).toBe(true);
    expect(got.messages[1]!.artifactHtml).toBe("<html>game</html>");
  });
});
