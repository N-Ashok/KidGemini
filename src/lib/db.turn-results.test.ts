// Resumable generations (TECH_DEBT #23): the server keeps each turn's
// finished reply keyed by the client's replyId, so a disconnected client
// collects the result instead of paying for a re-generation.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteTurnResultStore } from "./db";

describe("SqliteTurnResultStore", () => {
  const store = new SqliteTurnResultStore();

  it("T.1 start → running; complete → done with the full reply + game HTML", () => {
    store.start("r1", "user:a@x.com", 1000);
    expect(store.get("user:a@x.com", "r1")).toMatchObject({ status: "running" });
    store.complete("r1", "user:a@x.com", "Here's your game!", "<html>g</html>", 2000);
    expect(store.get("user:a@x.com", "r1")).toMatchObject({
      status: "done",
      text: "Here's your game!",
      artifactHtml: "<html>g</html>",
    });
  });

  it("T.2 fail → error status (client falls back to re-generating)", () => {
    store.start("r2", "user:a@x.com", 1000);
    store.fail("r2", "user:a@x.com", 2000);
    expect(store.get("user:a@x.com", "r2")).toMatchObject({ status: "error" });
  });

  it("T.3 ownership fail-closed: another identity sees nothing and cannot overwrite", () => {
    store.start("r3", "user:owner@x.com", 1000);
    store.complete("r3", "user:owner@x.com", "secret reply", null, 2000);
    expect(store.get("guest:thief", "r3")).toBeNull();
    store.complete("r3", "guest:thief", "hijacked", null, 3000);
    expect(store.get("user:owner@x.com", "r3")!.text).toBe("secret reply");
  });

  it("T.4 unknown replyId → null (client re-generates immediately)", () => {
    expect(store.get("user:a@x.com", "nope")).toBeNull();
  });

  it("T.5 rows older than the TTL are purged on the next start()", () => {
    store.start("old", "user:a@x.com", 1000);
    store.complete("old", "user:a@x.com", "stale", null, 1000);
    // 25h later a new turn starts — the old row is swept.
    store.start("fresh", "user:a@x.com", 1000 + 25 * 60 * 60 * 1000);
    expect(store.get("user:a@x.com", "old")).toBeNull();
    expect(store.get("user:a@x.com", "fresh")).toMatchObject({ status: "running" });
  });
});
