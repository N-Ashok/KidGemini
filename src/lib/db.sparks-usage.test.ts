// Sparks page data (docs/2026-08-27_PRD_SparksPage.md §3): what each chat
// used, and what each request in a chat cost — summed INSIDE SQLite via
// json_each so a chat's game HTML never has to be loaded to add up numbers.
// In-memory SQLite — no real .db file is ever touched (CLAUDE.md hard rule).
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";
import { SqliteChatHistoryStore } from "./db";
import type { Conversation } from "@/types/chat.types";

const U = "user:sparks@x.com";
const convo = (id: string, title: string, replies: (number | undefined)[]): Conversation => ({
  id, title,
  messages: replies.flatMap((s, i) => [
    { id: `${id}-c${i}`, role: "child" as const, text: `ask ${i} for ${title}`, createdAt: i * 2 + 1 },
    { id: `${id}-a${i}`, role: "assistant" as const, text: "Here!", artifactHtml: "<html>big game</html>", createdAt: i * 2 + 2, ...(s !== undefined ? { sparks: s } : {}) },
  ]),
});

describe("SqliteChatHistoryStore — Sparks usage", () => {
  const store = new SqliteChatHistoryStore();
  store.upsert(U, convo("s1", "Dino game", [12, 4]), 1000);
  store.upsert(U, convo("s2", "Car game", [undefined, 30]), 2000);
  store.upsert(U, convo("s3", "Just chat", [undefined]), 3000);
  store.upsert("user:other@x.com", convo("s9", "Not mine", [99]), 4000);

  it("U.1 sparksByConversation: one row per chat, summed receipts, newest first, only mine", () => {
    const rows = store.sparksByConversation(U);
    expect(rows.map((r) => [r.id, r.title, r.sparks])).toEqual([
      ["s3", "Just chat", 0],
      ["s2", "Car game", 30],
      ["s1", "Dino game", 16],
    ]);
    expect(rows.find((r) => r.id === "s9")).toBeUndefined();
  });

  it("U.2 sparksAsks: each child ask paired with what its reply cost; un-receipted replies are null, never 0", () => {
    expect(store.sparksAsks(U, "s2")).toEqual([
      { ask: "ask 0 for Car game", sparks: null, at: 2 },
      { ask: "ask 1 for Car game", sparks: 30, at: 4 },
    ]);
  });

  it("U.3 ownership is fail-closed for asks too", () => {
    expect(store.sparksAsks("user:other@x.com", "s1")).toEqual([]);
  });

  it("U.4 a soft-deleted chat leaves the usage list", () => {
    store.softDelete(U, "s3", 5000);
    expect(store.sparksByConversation(U).map((r) => r.id)).toEqual(["s2", "s1"]);
  });
});
