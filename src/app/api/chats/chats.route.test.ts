// /api/chats — server-side chat history (TECH_DEBT #26): identity keying
// (SSO session vs guest cookie), ownership fail-closed, pagination, migration.
// Real store on in-memory SQLite; only auth is mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

const authMock = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));

import { GET as listGET, POST as bulkPOST } from "./route";
import { GET as oneGET, PUT as onePUT, PATCH as onePATCH } from "./[id]/route";
import { GET as artifactGET } from "./[id]/messages/[messageId]/artifact/route";
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

// The scalable follow-up (2026-08-11) to the chat-history size-cap incident:
// old artifacts move out of the conversation row and are fetched on demand.
describe("GET /api/chats/:id/messages/:messageId/artifact", () => {
  const longConvo = (id: string) => ({
    id,
    title: "Long session",
    messages: Array.from({ length: 20 }, (_, i) => ({
      id: `${id}-m${i}`, role: "assistant" as const, text: "game", artifactHtml: "x".repeat(200 * 1024), createdAt: i,
    })), // 4MB total, 2x the 2MB inline budget — forces externalization
  });

  it("A.1 an externalized message's real html is fetchable by its owner", async () => {
    authMock.mockResolvedValue({ userId: "user:art@x.com" });
    await onePUT(makeReq({ body: { convo: longConvo("art1") } }), { params: { id: "art1" } });
    const got = await (await oneGET(makeReq({}), { params: { id: "art1" } })).json();
    const old = got.convo.messages.find((m: { artifactExternal?: boolean }) => m.artifactExternal);
    expect(old).toBeDefined();
    expect(old.artifactHtml).toBeUndefined();
    const res = await artifactGET(makeReq({}), { params: { id: "art1", messageId: old.id } });
    expect(res.status).toBe(200);
    expect((await res.json()).html).toBe("x".repeat(200 * 1024));
  });

  it("A.2 fail-closed: another identity gets 404, never the content", async () => {
    await onePUT(makeReq({ cookie: "guest:owner2", body: { convo: longConvo("art2") } }), { params: { id: "art2" } });
    const got = await (await oneGET(makeReq({ cookie: "guest:owner2" }), { params: { id: "art2" } })).json();
    const old = got.convo.messages.find((m: { artifactExternal?: boolean }) => m.artifactExternal);
    const stolen = await artifactGET(makeReq({ cookie: "guest:thief2" }), { params: { id: "art2", messageId: old.id } });
    expect(stolen.status).toBe(404);
    const anon = await artifactGET(makeReq({}), { params: { id: "art2", messageId: old.id } });
    expect(anon.status).toBe(404);
  });

  it("A.3 an unknown message id, or one that was never externalized, is a plain 404 (never an error)", async () => {
    authMock.mockResolvedValue({ userId: "user:art3@x.com" });
    await onePUT(makeReq({ body: { convo: convo("art3") } }), { params: { id: "art3" } }); // small — nothing externalized
    const miss = await artifactGET(makeReq({}), { params: { id: "art3", messageId: "art3-m2" } });
    expect(miss.status).toBe(404);
    const unknown = await artifactGET(makeReq({}), { params: { id: "art3", messageId: "no-such-id" } });
    expect(unknown.status).toBe(404);
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

// PATCH /api/chats/:id — rename + pin (owner ask 2026-08-06, sidebar ⋮ menu).
// Same fail-closed identity contract as GET/DELETE: foreign/unknown id → 404.
describe("PATCH /api/chats/:id — rename + pin", () => {
  it("C.11 renames a chat and the new title shows in the list", async () => {
    authMock.mockResolvedValue({ userId: "user:ren@x.com" });
    await onePUT(makeReq({ body: { convo: convo("rn1") } }), { params: { id: "rn1" } });
    const res = await onePATCH(makeReq({ body: { title: "  Space ideas  " } }), { params: { id: "rn1" } });
    expect(res.status).toBe(200);
    const list = await (await listGET(makeReq({}))).json();
    expect(list.chats.find((c: { id: string }) => c.id === "rn1").title).toBe("Space ideas");
  });

  it("C.12 pins and unpins — pinnedAt appears in the list index and clears again", async () => {
    authMock.mockResolvedValue({ userId: "user:pin@x.com" });
    await onePUT(makeReq({ body: { convo: convo("pi1") } }), { params: { id: "pi1" } });
    expect((await onePATCH(makeReq({ body: { pinned: true } }), { params: { id: "pi1" } })).status).toBe(200);
    let list = await (await listGET(makeReq({}))).json();
    expect(list.chats.find((c: { id: string }) => c.id === "pi1").pinnedAt).toEqual(expect.any(Number));
    expect((await onePATCH(makeReq({ body: { pinned: false } }), { params: { id: "pi1" } })).status).toBe(200);
    list = await (await listGET(makeReq({}))).json();
    expect(list.chats.find((c: { id: string }) => c.id === "pi1").pinnedAt).toBeNull();
  });

  it("C.13 fail-closed: foreign id → 404; no identity → 401; empty/invalid body → 400", async () => {
    await onePUT(makeReq({ cookie: "guest:owner2", body: { convo: convo("pv2") } }), { params: { id: "pv2" } });
    expect((await onePATCH(makeReq({ body: { title: "x" } }), { params: { id: "pv2" } })).status).toBe(401);
    authMock.mockResolvedValue({ userId: "user:other2@x.com" });
    expect((await onePATCH(makeReq({ body: { title: "x" } }), { params: { id: "pv2" } })).status).toBe(404);
    expect((await onePATCH(makeReq({ body: {} }), { params: { id: "pv2" } })).status).toBe(400);
    expect((await onePATCH(makeReq({ body: { title: "   " } }), { params: { id: "pv2" } })).status).toBe(400);
  });

  it("C.14 a manual rename survives the next turn's write-through upsert (the '=== New chat' guard)", async () => {
    // The container only auto-titles when title is still "New chat" — but the
    // PUT write-through sends the CLIENT's title, so the client state must
    // carry the rename; this pins the server half: a PUT with the renamed
    // title keeps it (upsert writes title verbatim, rename isn't special).
    authMock.mockResolvedValue({ userId: "user:keep@x.com" });
    await onePUT(makeReq({ body: { convo: convo("kp1") } }), { params: { id: "kp1" } });
    await onePATCH(makeReq({ body: { title: "Kept name" } }), { params: { id: "kp1" } });
    await onePUT(makeReq({ body: { convo: { ...convo("kp1"), title: "Kept name" } } }), { params: { id: "kp1" } });
    const list = await (await listGET(makeReq({}))).json();
    expect(list.chats.find((c: { id: string }) => c.id === "kp1").title).toBe("Kept name");
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
