/** Gate tests for PIN set/reset: fresh-session re-auth required, D6 format
 *  rules, fail-closed. PRD-PARENT-AUTH-ALERT-SCOPING §7/§8 set flow. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { SignJWT } from "jose";
import type { ParentAuthRecord } from "@/types/parent-auth.types";

const cookieJar: { token: string } = { token: "" };
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      name === "ariantra_session" && cookieJar.token ? { value: cookieJar.token } : undefined,
  }),
}));
vi.mock("server-only", () => ({}));

const rows = new Map<string, ParentAuthRecord>();
vi.mock("@/lib/db", () => ({
  SqliteParentAuthStore: class {
    get(id: string) {
      return rows.get(id) ?? null;
    }
    put(r: ParentAuthRecord) {
      rows.set(r.accountId, r);
    }
    recordAttempt() {}
  },
}));

import { POST } from "./route";

const SECRET = "test-secret-long-enough-0123456789";
const OLD = process.env.AUTH_JWT_SECRET;
process.env.AUTH_JWT_SECRET = SECRET;
afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD;
});

const ACCOUNT = "user:parent@example.com";

async function sessionToken(iatAgoSeconds = 0): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "session", email: "parent@example.com" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("p-1")
    .setIssuer("ariantra")
    .setIssuedAt(now - iatAgoSeconds)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  rows.clear();
});

describe("POST /api/parent/pin (set/reset)", () => {
  it("S.1 signed out → 401", async () => {
    cookieJar.token = "";
    expect((await POST(req({ pin: "8264" }))).status).toBe(401);
    expect(rows.size).toBe(0);
  });

  it("S.2 stale session → 403 stale_session (kid on a live parent session can't set a PIN)", async () => {
    cookieJar.token = await sessionToken(10 * 60); // 10 min old
    const res = await POST(req({ pin: "8264" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("stale_session");
    expect(rows.size).toBe(0);
  });

  it("S.3 fresh session + valid PIN → stored HASHED, parent cookie issued immediately", async () => {
    cookieJar.token = await sessionToken();
    const res = await POST(req({ pin: "8264" }));
    expect(res.status).toBe(200);
    const row = rows.get(ACCOUNT)!;
    expect(row.pinHash).not.toContain("8264");
    expect(row.attempts).toBe(0);
    expect(res.headers.get("set-cookie")).toContain("kidgemini_parent=");
    // BUG-FIX-LOG 2026-07-11: not Secure outside production, or http://localhost
    // drops the cookie and the gate re-prompts forever.
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).not.toContain("secure");
  });

  it("S.4 D6 format rules: wrong length, non-digits, trivial sequences → 422", async () => {
    cookieJar.token = await sessionToken();
    for (const bad of ["12", "12345", "12a4", "0000", "1234", "4321"]) {
      const res = await POST(req({ pin: bad }));
      expect(res.status).toBe(422);
    }
    expect(rows.size).toBe(0);
  });

  it("S.5 reset: an existing PIN is replaced (same fresh-session gate) and throttling clears", async () => {
    cookieJar.token = await sessionToken();
    await POST(req({ pin: "8264" }));
    const first = rows.get(ACCOUNT)!.pinHash;
    rows.set(ACCOUNT, { ...rows.get(ACCOUNT)!, attempts: 3, lockedUntil: Date.now() + 60_000 });
    const res = await POST(req({ pin: "7391" }));
    expect(res.status).toBe(200);
    const row = rows.get(ACCOUNT)!;
    expect(row.pinHash).not.toBe(first);
    expect(row.attempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it("S.6 malformed body → 400", async () => {
    cookieJar.token = await sessionToken();
    expect((await POST(req({}))).status).toBe(400);
  });
});
