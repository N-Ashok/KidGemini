/** /api/alerts is parent-session gated: no PIN param, no default, guests 401.
 *  Interim until Phase 2: the list is still global (kidgemini TECH_DEBT).
 *  PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 1. AUTH CODE — fail closed. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const cookieJar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (cookieJar[name] ? { value: cookieJar[name] } : undefined),
  }),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  SqliteAlertStore: class {
    list(limit: number) {
      return [{ id: "a1", severity: "high" }].slice(0, limit);
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

  it("A.3 a valid parent-session cookie reads the alerts", async () => {
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:parent@example.com", SECRET);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).alerts).toHaveLength(1);
  });

  it("A.4 a tampered cookie fails closed", async () => {
    cookieJar[PARENT_SESSION_COOKIE] =
      (await mintParentSession("user:parent@example.com", SECRET)) + "x";
    expect((await GET(req())).status).toBe(401);
  });
});
