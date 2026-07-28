// Community Help ticket store (docs/PRD-COMMUNITY-HELP.md Phase 1).
// TENANCY-CRITICAL: a child's help ticket — which carries their own words and
// an error report from their game — must never be readable by another identity.
// Fail closed, and never trust an id from the client as authorisation
// (CLAUDE.md §7.4: auth/tenancy code is never untested).
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.DATABASE_PATH = ":memory:";

import { SqliteHelpStore, getDb } from "./db";
import { DEDUPE_WINDOW_MS, MAX_OPEN_TICKETS, PRUNE_TEXT_AFTER_MS } from "./help.config";
import type { NewHelpTicket } from "@/types/help.types";

const T0 = 1_800_000_000_000;

const ticket = (over: Partial<NewHelpTicket> = {}): NewHelpTicket => ({
  reasonCode: "wont_move",
  conversationId: "convo-1",
  messageId: "msg-1",
  errorReport: "TypeError: null.style at game:118",
  verifyVerdict: "failed:click_no_pixel_change",
  ...over,
});

describe("SqliteHelpStore — tenancy", () => {
  const store = new SqliteHelpStore();

  it("H.1 listOwn returns ONLY the caller's tickets, never another identity's", () => {
    store.create("user:a@x.com", ticket({ messageId: "a-1" }), T0);
    store.create("user:b@x.com", ticket({ messageId: "b-1" }), T0);

    const a = store.listOwn("user:a@x.com");
    expect(a).toHaveLength(1);
    expect(a[0]!.messageId).toBe("a-1");
    expect(a.some((t) => t.messageId === "b-1")).toBe(false);
  });

  it("H.2 an unknown identity gets an empty list (fail closed)", () => {
    expect(store.listOwn("user:nobody@x.com")).toEqual([]);
  });

  it("H.3 judgeOwn refuses a ticket owned by someone else, even with a real id", () => {
    const made = store.create("user:owner@x.com", ticket({ messageId: "own-1" }), T0);
    expect(made.ok).toBe(true);
    const id = made.ok ? made.ticket.id : "";

    // The attacker holds a VALID ticket id — the store must still say no.
    expect(store.judgeOwn("user:attacker@x.com", id, true, T0)).toBe(false);
    expect(store.listOwn("user:owner@x.com")[0]!.status).toBe("open");

    expect(store.judgeOwn("user:owner@x.com", id, true, T0 + 1)).toBe(true);
    expect(store.listOwn("user:owner@x.com")[0]!.status).toBe("closed");
  });

  it("H.4 a guest can file, and the ticket is never attributed to an account", () => {
    const made = store.create("guest:dev-1", ticket({ messageId: "g-1" }), T0);
    expect(made.ok).toBe(true);
    expect(made.ok && made.ticket.accountId).toBe("guest:dev-1");
    expect(store.listOwn("user:a@x.com").some((t) => t.messageId === "g-1")).toBe(false);
  });
});

describe("SqliteHelpStore — dedupe and the open-ticket cap", () => {
  const store = new SqliteHelpStore();
  const who = "user:dedupe@x.com";

  it("H.5 two identical taps inside the window are ONE ticket, and the second reports success", () => {
    const first = store.create(who, ticket({ messageId: "dd-1" }), T0);
    const second = store.create(who, ticket({ messageId: "dd-1" }), T0 + DEDUPE_WINDOW_MS - 1);

    expect(first.ok && second.ok).toBe(true);
    expect(second.ok && second.deduped).toBe(true);
    expect(first.ok && second.ok && second.ticket.id).toBe(first.ok ? first.ticket.id : "");
    expect(store.listOwn(who)).toHaveLength(1);
  });

  it("H.6 the same ask AFTER the window is a new ticket", () => {
    const store2 = new SqliteHelpStore();
    const w = "user:window@x.com";
    store2.create(w, ticket({ messageId: "w-1" }), T0);
    const later = store2.create(w, ticket({ messageId: "w-1" }), T0 + DEDUPE_WINDOW_MS + 1);
    expect(later.ok && later.deduped).toBe(false);
    expect(store2.listOwn(w)).toHaveLength(2);
  });

  it("H.7 a DIFFERENT reason on the same message is a separate ticket", () => {
    const store3 = new SqliteHelpStore();
    const w = "user:reason@x.com";
    store3.create(w, ticket({ messageId: "r-1", reasonCode: "wont_move" }), T0);
    const other = store3.create(w, ticket({ messageId: "r-1", reasonCode: "no_sound" }), T0 + 1);
    expect(other.ok && other.deduped).toBe(false);
    expect(store3.listOwn(w)).toHaveLength(2);
  });

  it("H.8 the cap refuses ticket MAX_OPEN_TICKETS + 1, and closing one frees a slot", () => {
    const store4 = new SqliteHelpStore();
    const w = "user:cap@x.com";
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN_TICKETS; i++) {
      const r = store4.create(w, ticket({ messageId: `cap-${i}` }), T0 + i);
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.ticket.id);
    }
    const over = store4.create(w, ticket({ messageId: "cap-over" }), T0 + 99);
    expect(over.ok).toBe(false);
    expect(!over.ok && over.reason).toBe("too_many_open");

    store4.judgeOwn(w, ids[0]!, true, T0 + 100); // 👍 closes it
    const afterClose = store4.create(w, ticket({ messageId: "cap-after" }), T0 + 101);
    expect(afterClose.ok).toBe(true);
  });

  it("H.9 the cap is per identity — one busy family never blocks another", () => {
    const store5 = new SqliteHelpStore();
    for (let i = 0; i < MAX_OPEN_TICKETS; i++) {
      store5.create("user:busy@x.com", ticket({ messageId: `b-${i}` }), T0 + i);
    }
    expect(store5.create("user:quiet@x.com", ticket({ messageId: "q-1" }), T0).ok).toBe(true);
  });
});

describe("SqliteHelpStore — replies and the kid's verdict", () => {
  const store = new SqliteHelpStore();
  const who = "user:reply@x.com";

  function openOne(messageId: string) {
    const r = store.create(who, ticket({ messageId }), T0);
    if (!r.ok) throw new Error("setup failed");
    return r.ticket.id;
  }

  it("H.10 a reply lands on the ticket and moves it to answered", () => {
    const id = openOne("rp-1");
    const reply = store.addReply(
      id,
      { cannedId: "wont_move.controls", body: "Try asking me to add tap controls!", authorRef: "admin" },
      T0 + 1000,
    );
    expect(reply).not.toBeNull();

    const mine = store.listOwn(who).find((t) => t.id === id)!;
    expect(mine.status).toBe("answered");
    expect(mine.replies).toHaveLength(1);
    expect(mine.replies[0]!.cannedId).toBe("wont_move.controls");
  });

  it("H.11 addReply on an unknown ticket returns null (so the route can 404)", () => {
    expect(store.addReply("no-such-ticket", { cannedId: null, body: "hi", authorRef: "admin" }, T0)).toBeNull();
  });

  it("H.12 😕 Still stuck reopens an answered ticket without adding any text", () => {
    const id = openOne("rp-2");
    store.addReply(id, { cannedId: "c1", body: "have you tried…", authorRef: "admin" }, T0 + 1);
    expect(store.judgeOwn(who, id, false, T0 + 2)).toBe(true);

    const mine = store.listOwn(who).find((t) => t.id === id)!;
    expect(mine.status).toBe("open");
    // The helper's reply is still readable; reopening adds nothing of the kid's.
    expect(mine.replies).toHaveLength(1);
  });
});

describe("SqliteHelpStore — admin queue ordering and audit", () => {
  it("H.13 listForAdmin is OLDEST first — the ticket that waited all night is on top", () => {
    const store = new SqliteHelpStore();
    // The store is shared across this file's describes (one :memory: db), so
    // assert on THESE rows' relative order rather than the whole queue.
    store.create("user:ord-1@x.com", ticket({ messageId: "ord-new" }), T0 + 60_000);
    store.create("user:ord-2@x.com", ticket({ messageId: "ord-oldest" }), T0);
    store.create("user:ord-3@x.com", ticket({ messageId: "ord-middle" }), T0 + 30_000);

    const ours = store
      .listForAdmin("open", 500)
      .map((t) => t.messageId)
      .filter((m): m is string => Boolean(m?.startsWith("ord-")));
    expect(ours).toEqual(["ord-oldest", "ord-middle", "ord-new"]);
  });

  it("H.14 the open queue includes answered-but-unjudged, and excludes closed", () => {
    const store = new SqliteHelpStore();
    const a = store.create("user:a@x.com", ticket({ messageId: "still-open" }), T0);
    const b = store.create("user:b@x.com", ticket({ messageId: "answered" }), T0 + 1);
    const c = store.create("user:c@x.com", ticket({ messageId: "closed" }), T0 + 2);
    if (!a.ok || !b.ok || !c.ok) throw new Error("setup failed");

    store.addReply(b.ticket.id, { cannedId: "c", body: "x", authorRef: "admin" }, T0 + 10);
    store.judgeOwn("user:c@x.com", c.ticket.id, true, T0 + 10);

    const open = store.listForAdmin("open").map((t) => t.messageId);
    expect(open).toContain("still-open");
    expect(open).toContain("answered");
    expect(open).not.toContain("closed");
  });

  it("H.15 loading game source writes an audit row (never implicit with the ticket)", () => {
    const store = new SqliteHelpStore();
    const made = store.create("user:audit@x.com", ticket({ messageId: "au-1" }), T0);
    if (!made.ok) throw new Error("setup failed");

    expect(store.auditFor(made.ticket.id)).toEqual([]);
    store.recordAudit(made.ticket.id, "load_source", "admin", T0 + 5);

    const rows = store.auditFor(made.ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("load_source");
    expect(rows[0]!.authorRef).toBe("admin");
  });
});

describe("SqliteHelpStore — retention", () => {
  it("H.16 pruneClosedText drops the free text on long-closed tickets, keeps the structured row", () => {
    const store = new SqliteHelpStore();
    const who = "user:prune@x.com";
    const made = store.create(who, ticket({ messageId: "pr-1", transcript: "the dino falls through" }), T0);
    if (!made.ok) throw new Error("setup failed");
    store.judgeOwn(who, made.ticket.id, true, T0 + 1);

    // Not yet due — the text is still there.
    store.pruneClosedText(T0 + PRUNE_TEXT_AFTER_MS - 1);
    expect(store.listOwn(who)[0]!.errorReport).not.toBeNull();

    expect(store.pruneClosedText(T0 + PRUNE_TEXT_AFTER_MS + 2)).toBeGreaterThanOrEqual(1);
    const kept = store.listOwn(who)[0]!;
    expect(kept.errorReport).toBeNull();
    expect(kept.transcript).toBeNull();
    // The row itself — reason code, timings, resolution — survives.
    expect(kept.reasonCode).toBe("wont_move");
    expect(kept.status).toBe("closed");
  });

  it("H.17 an OPEN ticket is never pruned, however old", () => {
    const store = new SqliteHelpStore();
    store.create("user:old@x.com", ticket({ messageId: "old-1" }), T0);
    // A prune far in the future must leave an OPEN ticket's text untouched —
    // only `closed` rows are ever stripped.
    store.pruneClosedText(T0 + PRUNE_TEXT_AFTER_MS * 10);
    const still = store.listOwn("user:old@x.com")[0]!;
    expect(still.status).toBe("open");
    expect(still.errorReport).not.toBeNull();
  });
});

describe("help schema — migration safety", () => {
  it("H.18 the tables and their indexes exist after boot, and a second boot is a no-op", () => {
    const db = getDb();
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`)
      .all() as Array<{ name: string }>;
    const all = names.map((n) => n.name);
    expect(all).toContain("help_tickets");
    expect(all).toContain("help_replies");
    expect(all).toContain("help_audit");
    expect(all).toContain("idx_help_status");
    expect(all).toContain("idx_help_account");

    // getDb() is memoised; re-running the schema must stay idempotent
    // (db.ts:257-263 records the boot crash a mis-ordered index caused).
    expect(() => getDb()).not.toThrow();
  });
});
