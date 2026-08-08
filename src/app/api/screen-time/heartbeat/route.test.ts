/** POST /api/screen-time/heartbeat — signed-in-only presence ping
 *  (ScreenTimeHeartbeat.tsx). PRD-SCREEN-TIME-CAP-MVP Part B, extended
 *  2026-07-15 so playing an already-built game counts, not just chatting.
 *  Feature 4 (2026-07-28): response now carries nearingCap/capExceeded, and
 *  a fresh capExceeded crossing fires a fire-and-forget parent-alert-email
 *  bridge call — never awaited, so the platform being down/slow must never
 *  change this route's response or make it hang (fail-open contract).
 *
 *  Redesigned 2026-08-08 (docs/BUG-FIX-LOG.md "parent-PIN OTP false
 *  no-email", same fix class): the bridge is now called by `session.playerId`
 *  unconditionally on a capExceeded crossing — NOT gated on `session.email`,
 *  which a username/password login never carries. The old H.7 ("no email →
 *  never calls the bridge") was pinning the bug itself; the platform now
 *  decides whether it can resolve a contact email, not this route. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));

const pingCalls: Array<{ accountId: string; nowMs: number }> = [];
const recomputeCalls: Array<{ accountId: string; userLabel: string | null }> = [];
let storeThrows = false;
let recomputeResult = { activeMinutes: 0, capMinutes: null as number | null, nearingCap: false, capExceeded: false };
vi.mock("@/lib/db", () => ({
  SqliteScreenTimeStore: class {
    recordPing(accountId: string, nowMs: number) {
      if (storeThrows) throw new Error("boom");
      pingCalls.push({ accountId, nowMs });
    }
    recomputeAndMaybeAlert(accountId: string, userLabel: string | null) {
      recomputeCalls.push({ accountId, userLabel });
      return recomputeResult;
    }
  },
}));

type BridgeResult = { ok: true } | { ok: false; error: "no_email" | "send_failed" };
let bridgeResult: BridgeResult = { ok: true };
const bridgeCalls: Array<{ playerId: string; childLabel: string; activeMinutes: number; capMinutes: number }> = [];
let bridgeShouldReject = false;
vi.mock("@/lib/screen-time-alert-bridge", () => ({
  sendScreenTimeAlertEmail: (playerId: string, childLabel: string, activeMinutes: number, capMinutes: number) => {
    bridgeCalls.push({ playerId, childLabel, activeMinutes, capMinutes });
    return bridgeShouldReject ? Promise.reject(new Error("platform down")) : Promise.resolve(bridgeResult);
  },
}));

import { POST } from "./route";

beforeEach(() => {
  authMock.mockReset();
  pingCalls.length = 0;
  recomputeCalls.length = 0;
  bridgeCalls.length = 0;
  storeThrows = false;
  bridgeShouldReject = false;
  bridgeResult = { ok: true };
  recomputeResult = { activeMinutes: 0, capMinutes: null, nearingCap: false, capExceeded: false };
});

describe("POST /api/screen-time/heartbeat", () => {
  it("H.1 a guest (no session) gets 200 ok, no tracking happens", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, nearingCap: false, capExceeded: false });
    expect(pingCalls).toEqual([]);
    expect(recomputeCalls).toEqual([]);
  });

  it("H.2 a signed-in ping records a ping and triggers a recompute for that account", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", playerId: "player-1", name: "Kid" });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(pingCalls).toHaveLength(1);
    expect(pingCalls[0]!.accountId).toBe("user:kid@x.com");
    expect(recomputeCalls).toEqual([{ accountId: "user:kid@x.com", userLabel: "Kid" }]);
  });

  it("H.3 falls back to email when no display name is on the session", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", playerId: "player-1", email: "kid@x.com" });
    await POST();
    expect(recomputeCalls).toEqual([{ accountId: "user:kid@x.com", userLabel: "kid@x.com" }]);
  });

  it("H.4 a thrown error from the store fails open — still 200 with both flags false", async () => {
    storeThrows = true;
    authMock.mockResolvedValue({ userId: "user:kid@x.com", playerId: "player-1" });
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, nearingCap: false, capExceeded: false });
  });

  it("H.5 the response echoes the store's edge-triggered nearingCap/capExceeded flags", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", playerId: "player-1", name: "Kid" });
    recomputeResult = { activeMinutes: 25, capMinutes: 30, nearingCap: true, capExceeded: false };
    const res = await POST();
    const body = await res.json();
    expect(body).toEqual({ ok: true, nearingCap: true, capExceeded: false });
  });

  it("H.6 capExceeded fires the parent-alert bridge by playerId, fire-and-forget", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", playerId: "player-1", name: "Kid", email: "parent@x.com" });
    recomputeResult = { activeMinutes: 40, capMinutes: 30, nearingCap: false, capExceeded: true };
    const res = await POST();
    const body = await res.json();
    expect(body).toEqual({ ok: true, nearingCap: false, capExceeded: true });
    expect(bridgeCalls).toEqual([{ playerId: "player-1", childLabel: "Kid", activeMinutes: 40, capMinutes: 30 }]);
  });

  // THE bug (docs/BUG-FIX-LOG.md 2026-08-08): a session with NO email claim
  // — exactly what a plain username/password login produces — used to skip
  // the bridge call entirely, so that family NEVER got alerted, silently.
  // Now the bridge is always called; the PLATFORM decides whether it can
  // resolve a contact email.
  it("H.7 capExceeded with NO session.email STILL calls the bridge by playerId — the old bug", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", playerId: "player-nopwd", name: "Kid" }); // no email claim
    recomputeResult = { activeMinutes: 40, capMinutes: 30, nearingCap: false, capExceeded: true };
    const res = await POST();
    expect(res.status).toBe(200);
    expect(bridgeCalls).toEqual([{ playerId: "player-nopwd", childLabel: "Kid", activeMinutes: 40, capMinutes: 30 }]);
  });

  it("H.8 the bridge failing (platform down) never changes the 200 response — fail-open, fire-and-forget", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", playerId: "player-1", name: "Kid" });
    recomputeResult = { activeMinutes: 40, capMinutes: 30, nearingCap: false, capExceeded: true };
    bridgeShouldReject = true;
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, nearingCap: false, capExceeded: true });
  });

  it("H.9 the bridge resolving no_email never changes the 200 response — a genuine no-email account is not an error state here", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", playerId: "player-1", name: "Kid" });
    recomputeResult = { activeMinutes: 40, capMinutes: 30, nearingCap: false, capExceeded: true };
    bridgeResult = { ok: false, error: "no_email" };
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, nearingCap: false, capExceeded: true });
  });
});
