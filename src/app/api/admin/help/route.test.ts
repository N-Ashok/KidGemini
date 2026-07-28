/** POST /api/admin/help — the operator side of the help queue
 *  (docs/PRD-COMMUNITY-HELP.md §3.7/§3.8).
 *
 *  Four guarantees pinned here, because this is the one place an adult can send
 *  text to a child:
 *   · ADMIN_SECRET in the body, timing-safe, unset → 503 (never open)
 *   · every reply writes EXACTLY ONE ParentAlert — that row is the
 *     accountability guarantee, so a reply without it is a build failure
 *   · a guest ticket gets canned replies only (no parent to mirror to)
 *   · free text is screened, and loading game source is a separate audited action
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

const alertRows: Array<Record<string, unknown>> = [];
vi.mock("@/lib/alerts-sink", () => ({
  recordParentAlert: (alert: Record<string, unknown>) => {
    alertRows.push(alert);
  },
}));

import { POST } from "./route";
import { SqliteHelpStore } from "@/lib/db";
import { CANNED_REPLIES } from "@/lib/help-canned";

const SECRET = "admin-secret-for-tests";
const OLD = process.env.ADMIN_SECRET;
process.env.ADMIN_SECRET = SECRET;
afterAll(() => {
  process.env.ADMIN_SECRET = OLD;
});

const store = new SqliteHelpStore();
const post = (body: unknown) => ({ json: async () => body }) as never;
const CANNED = CANNED_REPLIES.find((r) => r.reasonCode === "wont_move")!;

let n = 0;
/** A fresh identity per seed by default — one account filing many tickets would
 *  legitimately hit MAX_OPEN_TICKETS (see db.help.test.ts H.8). */
function seed(accountId?: string) {
  const id = accountId ?? `user:kid-${n}@example.com`;
  const r = store.create(id, { reasonCode: "wont_move", messageId: `adm-${n++}` }, Date.now());
  if (!r.ok) throw new Error("seed failed");
  return r.ticket.id;
}

beforeEach(() => {
  alertRows.length = 0;
  process.env.ADMIN_SECRET = SECRET;
});

describe("the ADMIN_SECRET gate", () => {
  it("A.1 a wrong secret is 401", async () => {
    expect((await POST(post({ secret: "nope", action: "list" }))).status).toBe(401);
  });

  it("A.2 a missing secret is 401", async () => {
    expect((await POST(post({ action: "list" }))).status).toBe(401);
  });

  it("A.3 ADMIN_SECRET unset on the server fails CLOSED with 503, never open", async () => {
    delete process.env.ADMIN_SECRET;
    const res = await POST(post({ secret: "anything", action: "list" }));
    expect(res.status).toBe(503);
  });

  it("A.4 a malformed body is 400", async () => {
    const res = await POST({ json: async () => { throw new Error("bad"); } } as never);
    expect(res.status).toBe(400);
  });
});

describe("action: list", () => {
  it("A.5 returns the queue oldest-first with the waiting state already computed", async () => {
    seed();
    const res = await POST(post({ secret: SECRET, action: "list" }));
    expect(res.status).toBe(200);
    const { tickets } = await res.json();
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets[0]).toHaveProperty("ageState");
    expect(tickets[0]).toHaveProperty("waitingLabel");
    // Oldest first — a newest-first queue buries the all-night ticket.
    const times = tickets.map((t: { createdAt: number }) => t.createdAt);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("A.6 offers the canned replies for each ticket's reason", async () => {
    seed();
    const { tickets } = await (await POST(post({ secret: SECRET, action: "list" }))).json();
    const wontMove = tickets.find((t: { reasonCode: string }) => t.reasonCode === "wont_move")!;
    expect(wontMove.canned.map((c: { id: string }) => c.id)).toContain(CANNED.id);
  });
});

describe("action: reply", () => {
  it("A.7 a canned reply lands on the ticket and uses the library's exact text", async () => {
    const id = seed();
    const res = await POST(post({ secret: SECRET, action: "reply", ticketId: id, cannedId: CANNED.id }));
    expect(res.status).toBe(200);

    const t = store.getById(id)!;
    expect(t.status).toBe("answered");
    expect(t.replies[0]!.body).toBe(CANNED.body);
    expect(t.replies[0]!.cannedId).toBe(CANNED.id);
  });

  it("A.8 every reply writes EXACTLY ONE parent alert — the accountability guarantee", async () => {
    const id = seed("user:mirror@example.com");
    await POST(post({ secret: SECRET, action: "reply", ticketId: id, cannedId: CANNED.id }));

    expect(alertRows).toHaveLength(1);
    expect(alertRows[0]!.accountId).toBe("user:mirror@example.com");
    // origin "system" REQUIRES category null + action allow (alert.types.ts).
    expect(alertRows[0]!.origin).toBe("system");
    expect(alertRows[0]!.category).toBeNull();
    expect(alertRows[0]!.action).toBe("allow");
    expect(alertRows[0]!.severity).toBe("low");
    // The parent can read the words the helper sent.
    expect(String(alertRows[0]!.reason)).toContain(CANNED.body.slice(0, 20));
  });

  it("A.9 an unknown cannedId is refused — a reply id must prove it came from the library", async () => {
    const id = seed();
    expect((await POST(post({ secret: SECRET, action: "reply", ticketId: id, cannedId: "made.up" }))).status).toBe(400);
    expect(alertRows).toHaveLength(0);
  });

  it("A.10 an unknown ticket is 404 and writes no alert", async () => {
    const res = await POST(post({ secret: SECRET, action: "reply", ticketId: "nope", cannedId: CANNED.id }));
    expect(res.status).toBe(404);
    expect(alertRows).toHaveLength(0);
  });

  it("A.11 free text is allowed for an account, and marked as free text", async () => {
    const id = seed("user:free@example.com");
    const res = await POST(
      post({ secret: SECRET, action: "reply", ticketId: id, body: "I looked — try asking for tap controls." }),
    );
    expect(res.status).toBe(200);
    const t = store.getById(id)!;
    expect(t.replies[0]!.cannedId).toBeNull();
    expect(alertRows).toHaveLength(1);
  });

  it("A.12 free text containing blocked words is REJECTED at write time", async () => {
    const id = seed("user:screen@example.com");
    const res = await POST(post({ secret: SECRET, action: "reply", ticketId: id, body: "you are a shit builder" }));
    expect(res.status).toBe(422);
    expect(store.getById(id)!.replies).toHaveLength(0);
    expect(alertRows).toHaveLength(0);
  });

  it("A.13 free text that leaks contact details is REJECTED — no helper hands a child an address", async () => {
    const id = seed("user:pii@example.com");
    const res = await POST(
      post({ secret: SECRET, action: "reply", ticketId: id, body: "email me at helper@ariantra.com" }),
    );
    expect(res.status).toBe(422);
    expect(store.getById(id)!.replies).toHaveLength(0);
  });

  it("A.14 a GUEST ticket accepts canned replies but REFUSES free text (no parent to mirror to)", async () => {
    const guestTicket = seed("guest:device-9");
    expect(
      (await POST(post({ secret: SECRET, action: "reply", ticketId: guestTicket, body: "hand written" }))).status,
    ).toBe(403);
    expect(store.getById(guestTicket)!.replies).toHaveLength(0);

    const ok = await POST(post({ secret: SECRET, action: "reply", ticketId: guestTicket, cannedId: CANNED.id }));
    expect(ok.status).toBe(200);
    // A guest has no family account, so there is no parent alert to write.
    expect(alertRows).toHaveLength(0);
  });

  it("A.15 an empty reply is 400", async () => {
    const id = seed();
    expect((await POST(post({ secret: SECRET, action: "reply", ticketId: id, body: "   " }))).status).toBe(400);
  });
});

describe("action: source", () => {
  it("A.16 loading game source writes an audit row", async () => {
    const id = seed("user:src@example.com");
    expect(store.auditFor(id)).toHaveLength(0);

    const res = await POST(post({ secret: SECRET, action: "source", ticketId: id }));
    expect([200, 404]).toContain(res.status); // no conversation seeded → 404 is fine
    expect(store.auditFor(id)).toHaveLength(1);
    expect(store.auditFor(id)[0]!.action).toBe("load_source");
  });

  it("A.17 listing a ticket never includes its game source implicitly", async () => {
    seed();
    const { tickets } = await (await POST(post({ secret: SECRET, action: "list" }))).json();
    for (const t of tickets) {
      expect(t).not.toHaveProperty("artifactHtml");
      expect(JSON.stringify(t)).not.toContain("<!DOCTYPE");
    }
  });
});
