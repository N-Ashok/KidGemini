/** /api/help — a child asking a real person for help
 *  (docs/PRD-COMMUNITY-HELP.md Phase 1).
 *
 *  TENANCY + PRIVACY critical, so it runs against the REAL store:
 *   · identity always comes from the server, never from the request body
 *   · a ticket never carries the generated game's source
 *   · the child never learns WHICH admin answered
 *  Auth/safety code is never untested (CLAUDE.md §7.4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

let identity: string | null = "user:kid@example.com";
vi.mock("@/lib/chat-identity", () => ({
  resolveChatUser: async () => identity,
}));

import { GET, POST } from "./route";
import { POST as FEEDBACK } from "./feedback/route";
import { SqliteHelpStore } from "@/lib/db";
import { MAX_OPEN_TICKETS } from "@/lib/help.config";

const post = (body: unknown) => ({ json: async () => body }) as never;

const filed = (over: Record<string, unknown> = {}) => ({
  reasonCode: "wont_move",
  conversationId: "convo-1",
  messageId: "msg-1",
  errorReport: "TypeError: null.style at game:118",
  verifyVerdict: "failed:click_no_pixel_change",
  ...over,
});

beforeEach(() => {
  identity = "user:kid@example.com";
});

describe("POST /api/help", () => {
  it("P.1 files a ticket for the signed-in child and reports the id", async () => {
    const res = await POST(post(filed({ messageId: "p1" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ticketId).toBe("string");
    expect(body.status).toBe("open");
  });

  it("P.2 a GUEST can ask for help — the guest wall must not block it", async () => {
    identity = "guest:device-1";
    const res = await POST(post(filed({ messageId: "p2" })));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("P.3 a visitor with no identity at all is refused (nothing to attribute)", async () => {
    identity = null;
    expect((await POST(post(filed()))).status).toBe(401);
  });

  it("P.4 an unknown reason code is rejected — codes are a fixed set", async () => {
    const res = await POST(post(filed({ reasonCode: "made_up" })));
    expect(res.status).toBe(400);
  });

  it("P.5 the accountId can NOT be set from the request body", async () => {
    const res = await POST(post(filed({ messageId: "p5", accountId: "user:someone-else@x.com" })));
    expect(res.status).toBe(200);
    const mine = new SqliteHelpStore().listOwn("user:kid@example.com");
    expect(mine.some((t) => t.messageId === "p5")).toBe(true);
    expect(new SqliteHelpStore().listOwn("user:someone-else@x.com")).toEqual([]);
  });

  it("P.6 a payload carrying the generated game is refused — tickets never ship source", async () => {
    const game = "<!DOCTYPE html><html><body><script>let x=1</script></body></html>";
    const res = await POST(post(filed({ messageId: "p6", errorReport: game })));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("source_not_accepted");
  });

  it("P.7 an oversized transcript is truncated, not rejected", async () => {
    const res = await POST(post(filed({ messageId: "p7", reasonCode: "other", transcript: "a".repeat(5000) })));
    expect(res.status).toBe(200);
    const t = new SqliteHelpStore().listOwn("user:kid@example.com").find((x) => x.messageId === "p7")!;
    expect(t.transcript!.length).toBeLessThanOrEqual(1000);
  });

  it("P.8 re-tapping the same reason on the same game returns the SAME ticket, not an error", async () => {
    identity = "user:dupe@example.com";
    const first = await (await POST(post(filed({ messageId: "p8" })))).json();
    const second = await POST(post(filed({ messageId: "p8" })));
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.ticketId).toBe(first.ticketId);
    expect(body.alreadyOpen).toBe(true);
  });

  it("P.9 past the open-ticket cap the child gets a 429 that says what to do next", async () => {
    identity = "user:cap@example.com";
    for (let i = 0; i < MAX_OPEN_TICKETS; i++) {
      expect((await POST(post(filed({ messageId: `cap-${i}` })))).status).toBe(200);
    }
    const res = await POST(post(filed({ messageId: "cap-over" })));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("too_many_open");
    // No dead ends (CLAUDE.md §9): the message tells the kid what happens next.
    expect(body.message.length).toBeGreaterThan(10);
  });

  it("P.10 a malformed body is a 400, never a 500", async () => {
    const res = await POST({ json: async () => { throw new Error("not json"); } } as never);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/help", () => {
  it("P.11 returns only the caller's own tickets", async () => {
    identity = "user:mine@example.com";
    await POST(post(filed({ messageId: "mine-1" })));
    identity = "user:theirs@example.com";
    await POST(post(filed({ messageId: "theirs-1" })));

    identity = "user:mine@example.com";
    const { tickets } = await (await GET({} as never)).json();
    expect(tickets.map((t: { messageId: string }) => t.messageId)).toEqual(["mine-1"]);
  });

  it("P.12 no identity → empty list, never someone else's", async () => {
    identity = null;
    const { tickets } = await (await GET({} as never)).json();
    expect(tickets).toEqual([]);
  });

  it("P.13 a reply reaches the child WITHOUT revealing which admin wrote it", async () => {
    identity = "user:reply@example.com";
    const { ticketId } = await (await POST(post(filed({ messageId: "rp-1" })))).json();
    new SqliteHelpStore().addReply(
      ticketId,
      { cannedId: "wont_move.tap_controls", body: "Ask me to add tap controls!", authorRef: "admin:kohsa07" },
      Date.now(),
    );

    const { tickets } = await (await GET({} as never)).json();
    const mine = tickets.find((t: { id: string }) => t.id === ticketId)!;
    expect(mine.status).toBe("answered");
    expect(mine.replies[0].body).toContain("tap controls");
    // The helper is anonymous to the child by construction (PRD §3.8 c.4).
    expect(JSON.stringify(mine)).not.toContain("kohsa07");
    expect(mine.replies[0].authorRef).toBeUndefined();
  });
});

describe("POST /api/help/feedback", () => {
  it("P.14 👍 closes the child's own ticket", async () => {
    identity = "user:judge@example.com";
    const { ticketId } = await (await POST(post(filed({ messageId: "j-1" })))).json();
    const res = await FEEDBACK(post({ ticketId, helped: true }));
    expect(res.status).toBe(200);
    expect(new SqliteHelpStore().listOwn("user:judge@example.com")[0]!.status).toBe("closed");
  });

  it("P.15 😕 reopens it, and carries no text of the child's", async () => {
    identity = "user:judge2@example.com";
    const { ticketId } = await (await POST(post(filed({ messageId: "j-2" })))).json();
    const store = new SqliteHelpStore();
    store.addReply(ticketId, { cannedId: "c", body: "try this", authorRef: "admin" }, Date.now());

    const res = await FEEDBACK(post({ ticketId, helped: false, note: "still broken!!" }));
    expect(res.status).toBe(200);
    const t = store.listOwn("user:judge2@example.com")[0]!;
    expect(t.status).toBe("open");
    // Only the helper's reply exists — the child cannot write into the thread.
    expect(t.replies).toHaveLength(1);
    expect(JSON.stringify(t)).not.toContain("still broken");
  });

  it("P.16 judging SOMEONE ELSE'S ticket is refused even with a valid id", async () => {
    identity = "user:owner@example.com";
    const { ticketId } = await (await POST(post(filed({ messageId: "own-1" })))).json();

    identity = "user:attacker@example.com";
    expect((await FEEDBACK(post({ ticketId, helped: true }))).status).toBe(404);
    identity = "user:owner@example.com";
    expect(new SqliteHelpStore().listOwn("user:owner@example.com")[0]!.status).toBe("open");
  });

  it("P.17 an unknown ticket id is a 404", async () => {
    expect((await FEEDBACK(post({ ticketId: "nope", helped: true }))).status).toBe(404);
  });

  it("P.18 a missing helped flag is a 400", async () => {
    expect((await FEEDBACK(post({ ticketId: "x" }))).status).toBe(400);
  });
});
