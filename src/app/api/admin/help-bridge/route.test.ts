/**
 * The SOS/help bridge. Auth is the test surface here — the ACTIONS are already
 * covered by api/admin/help/route.test.ts, which now exercises the same
 * lib/help-admin module this route calls.
 *
 * The load-bearing case is HB.5: a caller must not be able to reach the queue
 * by putting ADMIN_SECRET in the body. This route's gate is the header, and a
 * body `secret` is dropped before the action runs — two gates that can be
 * confused for one another is how one of them ends up unenforced.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const SECRET = "test-shared-secret-value";
const req = (headers: Record<string, string> = {}, body: unknown = { action: "list" }) =>
  new NextRequest("https://ari.example.com/api/admin/help-bridge", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

let savedShared: string | undefined;
let savedAdmin: string | undefined;
beforeEach(() => {
  savedShared = process.env.AUTH_JWT_SECRET;
  savedAdmin = process.env.ADMIN_SECRET;
  process.env.AUTH_JWT_SECRET = SECRET;
  process.env.ADMIN_SECRET = "a-different-browser-secret";
});
afterEach(() => {
  if (savedShared === undefined) delete process.env.AUTH_JWT_SECRET; else process.env.AUTH_JWT_SECRET = savedShared;
  if (savedAdmin === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = savedAdmin;
});

describe("help-bridge auth", () => {
  it("HB.1 serves the queue with the shared secret", async () => {
    const res = await POST(req({ "x-admin-secret": SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tickets)).toBe(true);
    expect(body.targetHours).toBe(16);
  });

  it("HB.2 refuses a wrong secret", async () => {
    expect((await POST(req({ "x-admin-secret": "nope" }))).status).toBe(403);
  });

  it("HB.3 refuses a missing secret", async () => {
    expect((await POST(req())).status).toBe(403);
  });

  it("HB.4 FAILS CLOSED when the server has no shared secret configured", async () => {
    delete process.env.AUTH_JWT_SECRET;
    expect((await POST(req({ "x-admin-secret": SECRET }))).status).toBe(503);
  });

  it("HB.5 the browser route's ADMIN_SECRET in the BODY opens nothing here", async () => {
    const res = await POST(req({}, { action: "list", secret: "a-different-browser-secret" }));
    expect(res.status).toBe(403);
  });

  it("HB.6 a malformed body is a 400, not a crash — but only after auth passes", async () => {
    const bad = new NextRequest("https://ari.example.com/api/admin/help-bridge", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": SECRET },
      body: "not json",
    });
    expect((await POST(bad)).status).toBe(400);
    // …and an unauthenticated malformed body is still 403: auth comes first.
    const badNoAuth = new NextRequest("https://ari.example.com/api/admin/help-bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect((await POST(badNoAuth)).status).toBe(403);
  });

  it("HB.7 an unknown action is refused, never silently treated as list", async () => {
    // It lands on the ticketId guard first, so the code is bad_request rather
    // than unknown_action — the property that matters is that it REFUSES and
    // returns no queue, not which of the two 400s it picks.
    const res = await POST(req({ "x-admin-secret": SECRET }, { action: "delete_everything" }));
    expect(res.status).toBe(400);
    expect(await res.json()).not.toHaveProperty("tickets");
  });
});
