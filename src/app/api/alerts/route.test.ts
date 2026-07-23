/** /api/alerts is parent-session gated: no PIN param, no default, guests 401.
 *  PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2: the list is scoped to the verified
 *  parent's OWN account — never another family's. AUTH/TENANCY — fail closed. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const cookieJar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (cookieJar[name] ? { value: cookieJar[name] } : undefined),
  }),
}));
vi.mock("server-only", () => ({}));
// Per-account store: each family only has its OWN alerts. The route must query
// with the verified parent's accountId — so a parent only ever gets their own.
const FIXTURES: Record<string, Array<{ id: string; accountId: string }>> = {
  "user:parent@example.com": [{ id: "mine-1", accountId: "user:parent@example.com" }],
  "user:other@example.com": [{ id: "other-1", accountId: "user:other@example.com" }],
};
let listCalledWith: string | undefined;
vi.mock("@/lib/db", () => ({
  SqliteAlertStore: class {
    list(accountId: string, _limit: number) {
      listCalledWith = accountId;
      return FIXTURES[accountId] ?? []; // fail closed — unknown account gets nothing
    }
  },
}));

import { GET } from "./route";
import { mintParentSession, PARENT_SESSION_COOKIE } from "@/lib/parent-session";

const SECRET = "test-secret-long-enough-0123456789";
const OLD = { secret: process.env.AUTH_JWT_SECRET, pin: process.env.PARENT_PIN };
process.env.AUTH_JWT_SECRET = SECRET;
afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD.secret;
  process.env.PARENT_PIN = OLD.pin;
});

const req = (url = "http://localhost/api/alerts") => ({ nextUrl: new URL(url) }) as never;

beforeEach(() => {
  for (const k of Object.keys(cookieJar)) delete cookieJar[k];
});

describe("GET /api/alerts (parent-session gated)", () => {
  it("A.1 no parent-session cookie → 401 (guests and unverified parents alike)", async () => {
    expect((await GET(req())).status).toBe(401);
  });

  it("A.2 the old ?pin= param is DEAD — even the correct env PIN is ignored", async () => {
    process.env.PARENT_PIN = "9999";
    const res = await GET(req("http://localhost/api/alerts?pin=9999"));
    expect(res.status).toBe(401);
    const res2 = await GET(req("http://localhost/api/alerts?pin=1234"));
    expect(res2.status).toBe(401);
  });

  it("A.3 a valid parent-session cookie reads ONLY that parent's own account's alerts", async () => {
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:parent@example.com", SECRET);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const { alerts } = await res.json();
    // The store was queried with the verified parent's account, not globally.
    expect(listCalledWith).toBe("user:parent@example.com");
    expect(alerts.map((a: { id: string }) => a.id)).toEqual(["mine-1"]);
    // Another family's alert is NEVER returned.
    expect(alerts.some((a: { id: string }) => a.id === "other-1")).toBe(false);
  });

  it("A.3b a different verified parent gets THEIR own alerts, not the first parent's", async () => {
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:other@example.com", SECRET);
    const res = await GET(req());
    const { alerts } = await res.json();
    expect(listCalledWith).toBe("user:other@example.com");
    expect(alerts.map((a: { id: string }) => a.id)).toEqual(["other-1"]);
  });

  it("A.4 a tampered cookie fails closed", async () => {
    cookieJar[PARENT_SESSION_COOKIE] =
      (await mintParentSession("user:parent@example.com", SECRET)) + "x";
    expect((await GET(req())).status).toBe(401);
  });
});
