/** /api/admin/usage-bridge is a server-to-server bridge for Platform's
 *  `/studio/admin` Usage tab: `x-admin-secret` header checked against the
 *  SHARED AUTH_JWT_SECRET (constant-time), 503 when unset, 403 on a
 *  missing/wrong header. Never reachable directly from a browser. AUTH
 *  CODE — fail closed. */
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
    totalsSince(sinceMs: number) {
      return {
        eventCount: 1, promptTokens: 10, outputTokens: 20,
        thoughtTokens: 3, cachedTokens: 4,
        costUsd: sinceMs === 0 ? 2 : 1,
      };
    }
    uniquesSince() {
      return { signedInUsers: 2, guestBrowsers: 5, guestDevices: 3 };
    }
    repeatUsersSince() {
      return [{ userId: "user:a", userLabel: "Ann", activeDays: 4, eventCount: 9, firstSeen: 1, lastSeen: 2 }];
    }
  },
}));

import { POST } from "./route";

const OLD_SECRET = process.env.AUTH_JWT_SECRET;
afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD_SECRET;
});

const req = (body: unknown, headers: Record<string, string> = {}) =>
  ({
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as never;

beforeEach(() => {
  process.env.AUTH_JWT_SECRET = "shared-bridge-secret-long-and-random";
});

describe("POST /api/admin/usage-bridge (x-admin-secret)", () => {
  it("B.1 correct shared secret → data, same rollup shape as /api/usage", async () => {
    const res = await POST(req({ days: 7, detail: true }, { "x-admin-secret": "shared-bridge-secret-long-and-random" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual({ totalTokens: 1 });
    expect(body.events).toHaveLength(1);
    expect(body.periods.allTime.costInr).toBeDefined();
  });

  it("B.2 missing header → 403", async () => {
    const res = await POST(req({ days: 7 }));
    expect(res.status).toBe(403);
  });

  it("B.3 wrong header → 403", async () => {
    const res = await POST(req({ days: 7 }, { "x-admin-secret": "nope" }));
    expect(res.status).toBe(403);
  });

  it("B.4 AUTH_JWT_SECRET unset → 503, never open (fail closed on missing config)", async () => {
    delete process.env.AUTH_JWT_SECRET;
    const res = await POST(req({ days: 7 }, { "x-admin-secret": "anything" }));
    expect(res.status).toBe(503);
  });

  it("B.5 malformed body → 400", async () => {
    const res = await POST({
      json: async () => { throw new Error("bad"); },
      headers: { get: (k: string) => (k.toLowerCase() === "x-admin-secret" ? "shared-bridge-secret-long-and-random" : null) },
    } as never);
    expect(res.status).toBe(400);
  });
});
