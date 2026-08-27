// GET /api/sparks/usage — everything the Sparks page needs
// (docs/2026-08-27_PRD_SparksPage.md §3). Real store on in-memory SQLite;
// auth + the platform bridge are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";
const { authMock, statementMock } = vi.hoisted(() => ({ authMock: vi.fn(), statementMock: vi.fn() }));
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));
vi.mock("@/lib/sparks-bridge", () => ({ fetchParentStatement: (t: unknown) => statementMock(t) }));

import { NextRequest } from "next/server";
import { GET } from "./route";
import { SqliteChatHistoryStore } from "@/lib/db";

const req = (q = "", cookie = "ariantra_session=jwt-kid") =>
  new NextRequest(`http://localhost/api/sparks/usage${q}`, { headers: cookie ? { cookie } : {} });

const store = new SqliteChatHistoryStore();
store.upsert("user:kid@x.com", {
  id: "u1", title: "Dino game",
  messages: [
    { id: "m1", role: "child", text: "make a dino game", createdAt: 1 },
    { id: "m2", role: "assistant", text: "Here!", createdAt: 2, sparks: 40 },
    { id: "m3", role: "child", text: "add a boss", createdAt: 3 },
    { id: "m4", role: "assistant", text: "Done!", createdAt: 4, sparks: 6 },
  ],
}, 1000);

beforeEach(() => {
  authMock.mockReset();
  statementMock.mockReset();
  authMock.mockResolvedValue({ userId: "user:kid@x.com" });
  statementMock.mockResolvedValue({ status: 200, data: { balance: 954, transactions: [
    { id: "t1", kind: "signup_grant", amount: 1000 },
    { id: "t2", kind: "usage_debit", amount: -40 },
    { id: "t3", kind: "usage_debit", amount: -6 },
  ] } });
});

describe("GET /api/sparks/usage", () => {
  it("SU.1 signed out → 401, nothing fetched", async () => {
    authMock.mockResolvedValue(null);
    const res = await GET(req("", ""));
    expect(res.status).toBe(401);
    expect(statementMock).not.toHaveBeenCalled();
  });

  it("SU.2 summary: available / used / added from the ledger + what each chat used from the store", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.balance).toBe(954);
    expect(d.used).toBe(46);
    expect(d.added).toBe(1000);
    expect(d.chats).toEqual([{ id: "u1", title: "Dino game", updatedAt: 1000, sparks: 46 }]);
    expect(statementMock).toHaveBeenCalledWith("jwt-kid");
  });

  it("SU.3 platform down → the ledger numbers are null but the per-chat list still comes back", async () => {
    statementMock.mockResolvedValue({ status: 502, data: { error: "down" } });
    const d = await (await GET(req())).json();
    expect(d.balance).toBeNull();
    expect(d.used).toBeNull();
    expect(d.chats).toHaveLength(1);
  });

  it("SU.4 ?chat=<id> → what each request in that chat cost, in order", async () => {
    const d = await (await GET(req("?chat=u1"))).json();
    expect(d.asks).toEqual([
      { ask: "make a dino game", sparks: 40, at: 2 },
      { ask: "add a boss", sparks: 6, at: 4 },
    ]);
    expect(statementMock).not.toHaveBeenCalled(); // the drill-down never hits the platform
  });
});
