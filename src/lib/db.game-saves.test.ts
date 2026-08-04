// game_saves table + SqliteGameSaveStore (docs/2026-08-01_PRD_SaveContinueBuilding.md §3d).
// Real in-memory SQLite, one connection for the whole file (module singleton,
// same as db.ts's other store tests) — every test uses its own
// conversationId/messageId so rows never collide across tests.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteGameSaveStore, getDb } from "./db";
import { WRITE_DEBOUNCE_MS } from "./game-save.config";
import type { GameSaveState } from "@/types/game-save.types";

const state = (n = 1): GameSaveState => ({
  areas: [{ id: `area-${n}`, originX: 0, originZ: 0, objects: [{ type: "block", x: n, y: 0, z: 0 }] }],
});

describe("SqliteGameSaveStore", () => {
  it("upserts a new save and reads it back scoped to the owning user", () => {
    const store = new SqliteGameSaveStore();
    const wrote = store.upsert("user:a@x.com", { conversationId: "c-basic", messageId: "m-basic", state: state(1) }, 1000);
    expect(wrote).toBe(true);
    const got = store.get("user:a@x.com", "m-basic");
    expect(got?.state).toEqual(state(1));
    expect(got?.conversationId).toBe("c-basic");
  });

  it("returns null for an unknown message", () => {
    const store = new SqliteGameSaveStore();
    expect(store.get("user:a@x.com", "m-nope")).toBeNull();
  });

  it("is fail-closed on ownership: another user's id gets null, never the state", () => {
    const store = new SqliteGameSaveStore();
    store.upsert("user:owner@x.com", { conversationId: "c-own", messageId: "m-own", state: state(1) }, 1000);
    expect(store.get("user:thief@x.com", "m-own")).toBeNull();
  });

  it("one slot per (conversationId, messageId): overwrites in place, no history", () => {
    const store = new SqliteGameSaveStore();
    store.upsert("user:a@x.com", { conversationId: "c-overwrite", messageId: "m-overwrite", state: state(1) }, 1000);
    store.upsert(
      "user:a@x.com",
      { conversationId: "c-overwrite", messageId: "m-overwrite", state: state(2) },
      1000 + WRITE_DEBOUNCE_MS + 1,
    );
    const rows = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM game_saves WHERE conversationId = ? AND messageId = ?`)
      .get("c-overwrite", "m-overwrite") as { n: number };
    expect(rows.n).toBe(1);
    expect(store.get("user:a@x.com", "m-overwrite")?.state).toEqual(state(2));
  });

  it("regenerating the game (a new messageId) starts a fresh slot, never inherits an older save", () => {
    const store = new SqliteGameSaveStore();
    store.upsert("user:a@x.com", { conversationId: "c-regen", messageId: "m-regen-old", state: state(1) }, 1000);
    expect(store.get("user:a@x.com", "m-regen-new")).toBeNull();
  });

  it("debounces: a write inside the window is a silent no-op, the prior state is kept", () => {
    const store = new SqliteGameSaveStore();
    store.upsert("user:a@x.com", { conversationId: "c-debounce", messageId: "m-debounce", state: state(1) }, 1000);
    const wrote = store.upsert(
      "user:a@x.com",
      { conversationId: "c-debounce", messageId: "m-debounce", state: state(2) },
      1000 + WRITE_DEBOUNCE_MS - 1,
    );
    expect(wrote).toBe(false);
    expect(store.get("user:a@x.com", "m-debounce")?.state).toEqual(state(1));
  });

  it("allows a write exactly at the debounce boundary and after it", () => {
    const store = new SqliteGameSaveStore();
    store.upsert("user:a@x.com", { conversationId: "c-boundary", messageId: "m-boundary", state: state(1) }, 1000);
    const wrote = store.upsert(
      "user:a@x.com",
      { conversationId: "c-boundary", messageId: "m-boundary", state: state(2) },
      1000 + WRITE_DEBOUNCE_MS,
    );
    expect(wrote).toBe(true);
    expect(store.get("user:a@x.com", "m-boundary")?.state).toEqual(state(2));
  });

  it("deleteByConversation removes every save row for that conversation and reports the count", () => {
    const store = new SqliteGameSaveStore();
    store.upsert("user:a@x.com", { conversationId: "c-cascade", messageId: "m-cascade-1", state: state(1) }, 1000);
    store.upsert("user:a@x.com", { conversationId: "c-cascade", messageId: "m-cascade-2", state: state(2) }, 1000);
    store.upsert("user:a@x.com", { conversationId: "c-other", messageId: "m-other", state: state(3) }, 1000);

    expect(store.deleteByConversation("c-cascade")).toBe(2);
    expect(store.get("user:a@x.com", "m-cascade-1")).toBeNull();
    expect(store.get("user:a@x.com", "m-cascade-2")).toBeNull();
    expect(store.get("user:a@x.com", "m-other")).not.toBeNull(); // untouched
  });

  it("deleteByConversation on a conversation with no saves is a no-op returning 0", () => {
    const store = new SqliteGameSaveStore();
    expect(store.deleteByConversation("c-never-existed")).toBe(0);
  });

  it("a foreign user's upsert against an existing slot does not clobber the owner's state", () => {
    const store = new SqliteGameSaveStore();
    store.upsert("user:owner@x.com", { conversationId: "c-foreign", messageId: "m-foreign", state: state(1) }, 1000);
    const wrote = store.upsert(
      "user:thief@x.com",
      { conversationId: "c-foreign", messageId: "m-foreign", state: state(9) },
      1000 + WRITE_DEBOUNCE_MS + 1,
    );
    expect(wrote).toBe(false);
    expect(store.get("user:owner@x.com", "m-foreign")?.state).toEqual(state(1));
  });
});
