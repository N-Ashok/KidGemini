// /api/game-save — save & continue building, Phase 1 backend
// (docs/2026-08-01_PRD_SaveContinueBuilding.md §3e). Real store on
// in-memory SQLite; only auth is mocked. Same identity scheme as /api/chats
// (resolveChatUser: SSO session userId, else guest cookie).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

const authMock = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));

import { PUT, GET } from "./route";
import type { NextRequest } from "next/server";

function makeReq(opts: { cookie?: string; body?: unknown; query?: Record<string, string> } = {}): NextRequest {
  const qs = new URLSearchParams(opts.query ?? {});
  return {
    json: async () => opts.body ?? {},
    nextUrl: { searchParams: qs },
    cookies: { get: (k: string) => (k === "kg_guest" && opts.cookie ? { value: opts.cookie } : undefined) },
    headers: new Headers(),
  } as unknown as NextRequest;
}

const validState = {
  areas: [{ id: "city-1", originX: 0, originZ: 0, objects: [{ type: "block", x: 1, y: 0, z: 1 }] }],
};

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue(null);
});

describe("PUT /api/game-save", () => {
  it("G.1 no identity → 401", async () => {
    const res = await PUT(makeReq({ body: { conversationId: "c1", messageId: "m1", state: validState } }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("no_identity");
  });

  it("G.2 a signed-in user writes a save", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    const res = await PUT(makeReq({ body: { conversationId: "c1", messageId: "m-g2", state: validState } }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("G.3 a guest is keyed by the device cookie", async () => {
    const res = await PUT(
      makeReq({ cookie: "guest:g1", body: { conversationId: "c1", messageId: "m-g3", state: validState } }),
    );
    expect(res.status).toBe(200);
  });

  it("G.4 malformed state → 400, not a crash", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    const res = await PUT(
      makeReq({ body: { conversationId: "c1", messageId: "m-g4", state: { areas: "nope" } } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_state");
  });

  it("G.5 missing conversationId/messageId → 400", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    const res = await PUT(makeReq({ body: { state: validState } }));
    expect(res.status).toBe(400);
  });

  it("G.6 oversized state is rejected with a typed error, never silently truncated", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    const objects = Array.from({ length: 30_000 }, (_, i) => ({ type: "block", x: i, y: 0, z: i, rotation: 0 }));
    const huge = { areas: [{ id: "big", originX: 0, originZ: 0, objects }] };
    const res = await PUT(makeReq({ body: { conversationId: "c1", messageId: "m-g6", state: huge } }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("state_too_large");
  });

  it("G.7 a write inside the debounce window still returns 200 but reports written:false", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    await PUT(makeReq({ body: { conversationId: "c1", messageId: "m-g7", state: validState } }));
    const res = await PUT(makeReq({ body: { conversationId: "c1", messageId: "m-g7", state: validState } }));
    expect(res.status).toBe(200);
    expect((await res.json()).written).toBe(false);
  });
});

describe("GET /api/game-save", () => {
  it("G.8 round-trips a saved state for the owner", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    await PUT(makeReq({ body: { conversationId: "c1", messageId: "m-g8", state: validState } }));
    const res = await GET(makeReq({ query: { messageId: "m-g8" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).state).toEqual(validState);
  });

  it("G.9 missing save → 404", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    const res = await GET(makeReq({ query: { messageId: "m-nope" } }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("G.10 ownership is fail-closed: another identity gets 404, never the state", async () => {
    authMock.mockResolvedValue({ userId: "user:owner@x.com" });
    await PUT(makeReq({ body: { conversationId: "c1", messageId: "m-g10", state: validState } }));
    authMock.mockResolvedValue({ userId: "user:thief@x.com" });
    const res = await GET(makeReq({ query: { messageId: "m-g10" } }));
    expect(res.status).toBe(404);
  });

  it("G.11 no identity → 404 (fail closed, same as GET /api/chats/:id)", async () => {
    const res = await GET(makeReq({ query: { messageId: "m-g8" } }));
    expect(res.status).toBe(404);
  });

  it("G.12 missing messageId query param → 400", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    const res = await GET(makeReq({}));
    expect(res.status).toBe(400);
  });
});
