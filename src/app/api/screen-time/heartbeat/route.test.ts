/** POST /api/screen-time/heartbeat — signed-in-only presence ping
 *  (ScreenTimeHeartbeat.tsx). PRD-SCREEN-TIME-CAP-MVP Part B, extended
 *  2026-07-15 so playing an already-built game counts, not just chatting. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));

const pingCalls: Array<{ accountId: string; nowMs: number }> = [];
const recomputeCalls: Array<{ accountId: string; userLabel: string | null }> = [];
let storeThrows = false;
vi.mock("@/lib/db", () => ({
  SqliteScreenTimeStore: class {
    recordPing(accountId: string, nowMs: number) {
      if (storeThrows) throw new Error("boom");
      pingCalls.push({ accountId, nowMs });
    }
    recomputeAndMaybeAlert(accountId: string, userLabel: string | null) {
      recomputeCalls.push({ accountId, userLabel });
    }
  },
}));

import { POST } from "./route";

beforeEach(() => {
  authMock.mockReset();
  pingCalls.length = 0;
  recomputeCalls.length = 0;
  storeThrows = false;
});

describe("POST /api/screen-time/heartbeat", () => {
  it("H.1 a guest (no session) gets 200 ok, no tracking happens", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(pingCalls).toEqual([]);
    expect(recomputeCalls).toEqual([]);
  });

  it("H.2 a signed-in ping records a ping and triggers a recompute for that account", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", name: "Kid" });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(pingCalls).toHaveLength(1);
    expect(pingCalls[0]!.accountId).toBe("user:kid@x.com");
    expect(recomputeCalls).toEqual([{ accountId: "user:kid@x.com", userLabel: "Kid" }]);
  });

  it("H.3 falls back to email when no display name is on the session", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", email: "kid@x.com" });
    await POST();
    expect(recomputeCalls).toEqual([{ accountId: "user:kid@x.com", userLabel: "kid@x.com" }]);
  });

  it("H.4 a thrown error from the store fails open — still 200", async () => {
    storeThrows = true;
    authMock.mockResolvedValue({ userId: "user:kid@x.com" });
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
