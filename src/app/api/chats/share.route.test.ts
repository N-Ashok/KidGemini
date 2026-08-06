// /api/chats/:id/share — parent-gated share link (2026-08-06_PRD_
// ShareConversation.md). Real store on in-memory SQLite; auth + parent
// session mocked. AUTH CODE — the gates here are the whole feature.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

const authMock = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));
const parentMock = vi.fn();
vi.mock("@/lib/parent-session.server", () => ({ getVerifiedParentAccount: () => parentMock() }));

import { POST as sharePOST, DELETE as shareDELETE } from "./[id]/share/route";
import { PUT as onePUT } from "./[id]/route";
import { SqliteChatHistoryStore } from "@/lib/db";
import type { NextRequest } from "next/server";

function makeReq(opts: { cookie?: string; body?: unknown } = {}): NextRequest {
  return {
    json: async () => opts.body ?? {},
    nextUrl: { searchParams: new URLSearchParams(), origin: "https://games-lab.ariantra.com" },
    cookies: { get: (k: string) => (k === "kg_guest" && opts.cookie ? { value: opts.cookie } : undefined) },
    headers: new Headers(),
  } as unknown as NextRequest;
}

const convo = (id: string) => ({
  id,
  title: `Chat ${id}`,
  messages: [{ id: `${id}-m1`, role: "child", text: "make a game", createdAt: 1 }],
});

const store = new SqliteChatHistoryStore();

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue(null);
  parentMock.mockReset();
  parentMock.mockResolvedValue(null);
});

describe("POST /api/chats/:id/share", () => {
  it("S.1 owner + verified parent session → mints a share URL, idempotent while live", async () => {
    authMock.mockResolvedValue({ userId: "user:fam@x.com" });
    await onePUT(makeReq({ body: { convo: convo("sc1") } }), { params: { id: "sc1" } });
    parentMock.mockResolvedValue("user:fam@x.com");
    const res = await sharePOST(makeReq({}), { params: { id: "sc1" } });
    expect(res.status).toBe(200);
    const { url } = await res.json();
    expect(url).toMatch(/^https:\/\/games-lab\.ariantra\.com\/share\/chat\/[0-9a-f]{32}$/);
    // second POST returns the SAME live link, not a new one
    const again = await (await sharePOST(makeReq({}), { params: { id: "sc1" } })).json();
    expect(again.url).toBe(url);
    // and the public read works with that token
    const token = url.split("/").at(-1)!;
    expect(store.getSharedByToken(token)!.title).toBe("Chat sc1");
  });

  it("S.2 NO parent session → 403, even for the chat's owner (the PIN gate is the feature)", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com" });
    await onePUT(makeReq({ body: { convo: convo("sc2") } }), { params: { id: "sc2" } });
    const res = await sharePOST(makeReq({}), { params: { id: "sc2" } });
    expect(res.status).toBe(403);
    expect(store.getShareToken("user:kid@x.com", "sc2")).toEqual({ shareToken: null });
  });

  it("S.3 fail-closed: no identity → 401; foreign id → 404 (parent session alone is not enough)", async () => {
    expect((await sharePOST(makeReq({}), { params: { id: "any" } })).status).toBe(401);
    authMock.mockResolvedValue({ userId: "user:owner3@x.com" });
    await onePUT(makeReq({ body: { convo: convo("sc3") } }), { params: { id: "sc3" } });
    authMock.mockResolvedValue({ userId: "user:other@x.com" });
    parentMock.mockResolvedValue("user:other@x.com");
    expect((await sharePOST(makeReq({}), { params: { id: "sc3" } })).status).toBe(404);
  });

  it("S.4 re-share after revoke mints a FRESH token — the old link stays dead", async () => {
    authMock.mockResolvedValue({ userId: "user:re@x.com" });
    await onePUT(makeReq({ body: { convo: convo("sc4") } }), { params: { id: "sc4" } });
    parentMock.mockResolvedValue("user:re@x.com");
    const first = (await (await sharePOST(makeReq({}), { params: { id: "sc4" } })).json()).url;
    await shareDELETE(makeReq({}), { params: { id: "sc4" } });
    const second = (await (await sharePOST(makeReq({}), { params: { id: "sc4" } })).json()).url;
    expect(second).not.toBe(first);
    expect(store.getSharedByToken(first.split("/").at(-1)!)).toBeNull();
    expect(store.getSharedByToken(second.split("/").at(-1)!)).not.toBeNull();
  });
});

describe("DELETE /api/chats/:id/share", () => {
  it("S.5 owner revokes WITHOUT a parent session (turning off only reduces exposure); public read dies", async () => {
    authMock.mockResolvedValue({ userId: "user:rv@x.com" });
    await onePUT(makeReq({ body: { convo: convo("sc5") } }), { params: { id: "sc5" } });
    parentMock.mockResolvedValue("user:rv@x.com");
    const url = (await (await sharePOST(makeReq({}), { params: { id: "sc5" } })).json()).url;
    parentMock.mockResolvedValue(null); // parent session expired — revoke must still work
    expect((await shareDELETE(makeReq({}), { params: { id: "sc5" } })).status).toBe(200);
    expect(store.getSharedByToken(url.split("/").at(-1)!)).toBeNull();
  });

  it("S.6 revoke is fail-closed too: no identity → 401, foreign id → 404", async () => {
    expect((await shareDELETE(makeReq({}), { params: { id: "any" } })).status).toBe(401);
    authMock.mockResolvedValue({ userId: "user:nobody@x.com" });
    expect((await shareDELETE(makeReq({}), { params: { id: "sc5" } })).status).toBe(404);
  });
});
