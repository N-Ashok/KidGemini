// The missing-sound register (owner decision 2026-08-29): server-side only,
// never shown to a child. One row per asset name, counted, so the weekly
// review can rank real demand. In-memory SQLite — no real .db file is ever
// touched (CLAUDE.md hard rule).
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";
import { SqliteMissingAssetStore } from "./db";

describe("SqliteMissingAssetStore", () => {
  const store = new SqliteMissingAssetStore();

  it("MR.1 records a miss and counts repeats rather than duplicating rows", () => {
    store.record([{ name: "bg_loop_adventure", kind: "music" }], 1000);
    store.record([{ name: "bg_loop_adventure", kind: "music" }], 2000);
    store.record([{ name: "bump", kind: "sfx" }], 1500);
    const rows = store.top(10);
    const adv = rows.find((r) => r.name === "bg_loop_adventure")!;
    expect(adv.count).toBe(2);
    expect(adv.kind).toBe("music");
    expect(adv.firstSeen).toBe(1000);
    expect(adv.lastSeen).toBe(2000);
    expect(rows.find((r) => r.name === "bump")!.count).toBe(1);
  });

  it("MR.2 ranks by demand — the most-asked-for missing sound comes first", () => {
    for (let i = 0; i < 5; i++) store.record([{ name: "shoot", kind: "sfx" }], 3000 + i);
    expect(store.top(3)[0]!.name).toBe("shoot");
  });

  it("MR.3 an empty batch is a no-op, and recording never throws", () => {
    expect(() => store.record([], 4000)).not.toThrow();
    const before = store.top(50).length;
    store.record([], 4001);
    expect(store.top(50).length).toBe(before);
  });
});
