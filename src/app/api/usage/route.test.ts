/** /api/usage is OPERATOR tooling: ADMIN_SECRET in a POST body, no fallback,
 *  503 when unset, and the parent PIN means nothing here (§9: the two
 *  surfaces are authorized independently). AUTH CODE — fail closed. */
import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  SqliteUsageStore: class {
    summarizeSince() {
      return { totalTokens: 1 };
    }
    listSince() {
      return [{ id: "e1" }];
    }
  },
}));

import { POST } from "./route";

const OLD = { admin: process.env.ADMIN_SECRET, pin: process.env.PARENT_PIN };
afterAll(() => {
  process.env.ADMIN_SECRET = OLD.admin;
  process.env.PARENT_PIN = OLD.pin;
});

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  process.env.ADMIN_SECRET = "op-secret-long-and-random";
  delete process.env.PARENT_PIN;
});

describe("POST /api/usage (ADMIN_SECRET)", () => {
  it("U.1 correct secret → data", async () => {
    const res = await POST(req({ secret: "op-secret-long-and-random", days: 7, detail: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual({ totalTokens: 1 });
    expect(body.events).toHaveLength(1);
  });

  it("U.2 wrong or missing secret → 401", async () => {
    expect((await POST(req({ secret: "nope" }))).status).toBe(401);
    expect((await POST(req({}))).status).toBe(401);
  });

  it("U.3 ADMIN_SECRET unset → 503, never open (fail closed on missing config)", async () => {
    delete process.env.ADMIN_SECRET;
    expect((await POST(req({ secret: "anything" }))).status).toBe(503);
  });

  it("U.4 the parent PIN does NOT open the admin surface (§9 independence)", async () => {
    process.env.PARENT_PIN = "8264"; // even if a stale env var lingers
    expect((await POST(req({ secret: "8264" }))).status).toBe(401);
    expect((await POST(req({ pin: "8264" }))).status).toBe(401);
  });

  it("U.5 malformed body → 400", async () => {
    const res = await POST({ json: async () => { throw new Error("bad"); } } as never);
    expect(res.status).toBe(400);
  });
});
