/** GET /api/parent/help — the accountability surface: a parent can read every
 *  word any adult said to their child (docs/PRD-COMMUNITY-HELP.md §3.8 c.3).
 *  Same PIN-verified parent-session gate as /api/alerts; another family's
 *  tickets are never reachable. AUTH/TENANCY — fail closed. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const cookieJar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (cookieJar[name] ? { value: cookieJar[name] } : undefined) }),
}));
vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { GET } from "./route";
import { SqliteHelpStore } from "@/lib/db";
import { mintParentSession, PARENT_SESSION_COOKIE } from "@/lib/parent-session";

const SECRET = "test-secret-long-enough-0123456789";
const OLD = process.env.AUTH_JWT_SECRET;
process.env.AUTH_JWT_SECRET = SECRET;
afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD;
});

const store = new SqliteHelpStore();
const T0 = 1_800_000_000_000;

const seed = (accountId: string, messageId: string) => {
  const r = store.create(accountId, { reasonCode: "wont_move", messageId }, T0);
  if (!r.ok) throw new Error("seed failed");
  return r.ticket.id;
};

beforeEach(() => {
  for (const k of Object.keys(cookieJar)) delete cookieJar[k];
});

describe("GET /api/parent/help", () => {
  it("PH.1 no verified parent session → 401", async () => {
    expect((await GET({} as never)).status).toBe(401);
  });

  it("PH.2 a tampered cookie fails closed", async () => {
    cookieJar[PARENT_SESSION_COOKIE] = (await mintParentSession("user:mum@a.com", SECRET)) + "x";
    expect((await GET({} as never)).status).toBe(401);
  });

  it("PH.3 a verified parent sees their own child's tickets and every word of the reply", async () => {
    const id = seed("user:mum@a.com", "ph-1");
    store.addReply(
      id,
      { cannedId: "wont_move.tap_controls", body: "Ask me to add tap controls!", authorRef: "admin:kohsa07" },
      T0 + 100,
    );

    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:mum@a.com", SECRET);
    const res = await GET({} as never);
    expect(res.status).toBe(200);
    const { tickets } = await res.json();
    const mine = tickets.find((t: { id: string }) => t.id === id)!;
    expect(mine.replies[0].body).toContain("tap controls");
    // The parent can tell a reviewed reply from free text — that's the point of
    // marking free text as the exception.
    expect(mine.replies[0].canned).toBe(true);
  });

  it("PH.4 a free-text reply is flagged as such to the parent", async () => {
    const id = seed("user:mum2@a.com", "ph-2");
    store.addReply(id, { cannedId: null, body: "typed by hand", authorRef: "admin" }, T0 + 100);

    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:mum2@a.com", SECRET);
    const { tickets } = await (await GET({} as never)).json();
    expect(tickets[0].replies[0].canned).toBe(false);
  });

  it("PH.5 one family NEVER sees another family's tickets", async () => {
    const aId = seed("user:familyA@a.com", "fa-1");
    const bId = seed("user:familyB@b.com", "fb-1");

    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:familyA@a.com", SECRET);
    const { tickets } = await (await GET({} as never)).json();
    const ids = tickets.map((t: { id: string }) => t.id);
    expect(ids).toContain(aId);
    expect(ids).not.toContain(bId);
  });

  it("PH.6 a parent with no tickets gets an empty list, not another account's", async () => {
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:nobody@x.com", SECRET);
    const { tickets } = await (await GET({} as never)).json();
    expect(tickets).toEqual([]);
  });
});
