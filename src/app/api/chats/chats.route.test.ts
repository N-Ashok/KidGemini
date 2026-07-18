// /api/chats — server-side chat history (TECH_DEBT #26): identity keying
// (SSO session vs guest cookie), ownership fail-closed, pagination, migration.
// Real store on in-memory SQLite; only auth is mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

const authMock = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));

import { GET as listGET, POST as bulkPOST } from "./route";
import { GET as oneGET, PUT as onePUT } from "./[id]/route";
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

const convo = (id: string, title = `Chat ${id}`) => ({
  id,
  title,
  messages: [
    { id: `${id}-m1`, role: "child", text: "make a game", createdAt: 1 },
    { id: `${id}-m2`, role: "assistant", text: "done!", artifactHtml: "<html>g</html>", createdAt: 2 },
  ],
});

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue(null);
});

describe("PUT + GET /api/chats/:id", () => {
  it("C.1 a signed-in user round-trips a conversation (game HTML included)", async () => {
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    const put = await onePUT(makeReq({ body: { convo: convo("c1") } }), { params: { id: "c1" } });
    expect(put.status).toBe(200);
    const got = await oneGET(makeReq({}), { params: { id: "c1" } });
    expect(got.status).toBe(200);
    expect((await got.json()).convo.messages[1].artifactHtml).toBe("<html>g</html>");
  });

  it("C.2 a guest is keyed by the device cookie", async () => {
    await onePUT(makeReq({ cookie: "guest:g1", body: { convo: convo("gc1") } }), { params: { id: "gc1" } });
    const got = await oneGET(makeReq({ cookie: "guest:g1" }), { params: { id: "gc1" } });
    expect(got.status).toBe(200);
  });

  it("C.3 ownership is fail-closed: another identity gets 404, never the content", async () => {
    await onePUT(makeReq({ cookie: "guest:owner", body: { convo: convo("priv") } }), { params: { id: "priv" } });
    expect((await oneGET(makeReq({ cookie: "guest:thief" }), { params: { id: "priv" } })).status).toBe(404);
    authMock.mockResolvedValue({ userId: "user:other@x.com" });
    expect((await oneGET(makeReq({}), { params: { id: "priv" } })).status).toBe(404);
  });

  it("C.4 no identity → 401 on write; malformed convo → 400", async () => {
    expect((await onePUT(makeReq({ body: { convo: convo("x") } }), { params: { id: "x" } })).status).toBe(401);
    authMock.mockResolvedValue({ userId: "user:a@x.com" });
    const bad = await onePUT(makeReq({ body: { convo: { id: "x", title: "t", messages: [{ nope: 1 }] } } }), { params: { id: "x" } });
    expect(bad.status).toBe(400);
    // id mismatch between URL and body is rejected too.
    const mismatch = await onePUT(makeReq({ body: { convo: convo("y") } }), { params: { id: "x" } });
    expect(mismatch.status).toBe(400);
  });
});

describe("GET /api/chats — paginated index", () => {
  it("C.5 lists newest-first summaries and pages with the before cursor", async () => {
    authMock.mockResolvedValue({ userId: "user:page@x.com" });
    for (let i = 0; i < 5; i++) {
      await onePUT(makeReq({ body: { convo: convo(`p${i}`) } }), { params: { id: `p${i}` } });
    }
    const page1 = await (await listGET(makeReq({ query: { limit: "3" } }))).json();
    expect(page1.chats).toHaveLength(3);
    expect(page1.chats[0]).not.toHaveProperty("messages");
    const last = page1.chats.at(-1);
    const page2 = await (
      await listGET(makeReq({ query: { limit: "3", before: String(last.updatedAt), beforeId: last.id } }))
    ).json();
    expect(page2.chats.length).toBeGreaterThan(0);
    const ids1 = page1.chats.map((c: { id: string }) => c.id);
    for (const c of page2.chats) expect(ids1).not.toContain(c.id);
  });

  it("C.6 no identity → empty list (a brand-new visitor, not an error)", async () => {
    const res = await listGET(makeReq({}));
    expect(res.status).toBe(200);
    expect((await res.json()).chats).toEqual([]);
  });
});

describe("GET /api/chats — guest→account claim on login", () => {
  it("C.8 signing in while still holding the guest cookie claims the guest's chats into the account", async () => {
    // Chatted as a guest first — chats land under the guest cookie's identity.
    await onePUT(makeReq({ cookie: "guest:merge1", body: { convo: convo("mgc1") } }), { params: { id: "mgc1" } });
    await onePUT(makeReq({ cookie: "guest:merge1", body: { convo: convo("mgc2") } }), { params: { id: "mgc2" } });

    // Same device, now signed in — the browser still sends the (httpOnly) guest cookie
    // alongside the fresh SSO session, same as a real post-login request.
    authMock.mockResolvedValue({ userId: "user:merge@x.com" });
    const list = await (await listGET(makeReq({ cookie: "guest:merge1" }))).json();

    expect(list.chats.map((c: { id: string }) => c.id).sort()).toEqual(["mgc1", "mgc2"]);
    // And the guest identity itself is left with nothing — fully migrated, not copied.
    // (Force identity resolution back to guest-cookie-only, as it would be for
    // any request the platform's SSO session cookie never reaches.)
    authMock.mockResolvedValue(null);
    expect((await oneGET(makeReq({ cookie: "guest:merge1" }), { params: { id: "mgc1" } })).status).toBe(404);
  });

  it("C.9 a guest-only request (no session) never claims anything", async () => {
    await onePUT(makeReq({ cookie: "guest:onlyg", body: { convo: convo("og1") } }), { params: { id: "og1" } });
    const list = await (await listGET(makeReq({ cookie: "guest:onlyg" }))).json();
    expect(list.chats.map((c: { id: string }) => c.id)).toEqual(["og1"]);
  });

  it("C.10 claiming twice (e.g. a second tab) is idempotent — no error, no duplicates", async () => {
    await onePUT(makeReq({ cookie: "guest:merge2", body: { convo: convo("m2a") } }), { params: { id: "m2a" } });
    authMock.mockResolvedValue({ userId: "user:merge2@x.com" });
    await listGET(makeReq({ cookie: "guest:merge2" }));
    const list = await (await listGET(makeReq({ cookie: "guest:merge2" }))).json();
    expect(list.chats.map((c: { id: string }) => c.id)).toEqual(["m2a"]);
  });
});

describe("POST /api/chats — device migration", () => {
  it("C.7 bulk-uploads a device's chats, skipping malformed rows, idempotently", async () => {
    authMock.mockResolvedValue({ userId: "user:mig@x.com" });
    const res = await bulkPOST(makeReq({ body: { convos: [convo("m1"), { junk: true }, convo("m2")] } }));
    expect((await res.json()).saved).toBe(2);
    await bulkPOST(makeReq({ body: { convos: [convo("m1")] } })); // re-run: no dupes
    const list = await (await listGET(makeReq({}))).json();
    expect(list.chats.filter((c: { id: string }) => c.id.startsWith("m"))).toHaveLength(2);
  });
});
