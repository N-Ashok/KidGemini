/** Gate tests for PIN verify: session-bound, throttled, cookie-issuing,
 *  fail-closed. PRD-PARENT-AUTH-ALERT-SCOPING §8 verify flow. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { SignJWT } from "jose";
import { hashPin, LOCKOUT_MS, MAX_PIN_ATTEMPTS } from "@/lib/parent-pin";
import type { ParentAuthRecord } from "@/types/parent-auth.types";

const cookieJar: { token: string } = { token: "" };
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      name === "ariantra_session" && cookieJar.token ? { value: cookieJar.token } : undefined,
  }),
}));
vi.mock("server-only", () => ({}));

// In-memory parent_auth store — route tests never touch real SQLite.
const rows = new Map<string, ParentAuthRecord>();
vi.mock("@/lib/db", () => ({
  SqliteParentAuthStore: class {
    get(id: string) {
      return rows.get(id) ?? null;
    }
    put(r: ParentAuthRecord) {
      rows.set(r.accountId, r);
    }
    recordAttempt(id: string, f: Pick<ParentAuthRecord, "attempts" | "lockedUntil" | "lastLockoutAt">) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, ...f });
    }
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

async function sessionToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "session", email: "parent@example.com" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("p-1")
    .setIssuer("ariantra")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(async () => {
  rows.clear();
  cookieJar.token = await sessionToken();
  rows.set(ACCOUNT, {
    accountId: ACCOUNT,
    pinHash: hashPin("8264"),
    setAt: Date.now() - 1000,
    attempts: 0,
    lockedUntil: null,
    lastLockoutAt: null,
  });
});

describe("POST /api/parent/verify-pin", () => {
  it("V.1 signed out (guest) → 401 before any PIN logic (D3)", async () => {
    cookieJar.token = "";
    const res = await POST(req({ pin: "8264" }));
    expect(res.status).toBe(401);
  });

  it("V.2 correct PIN → 200 and sets the HttpOnly parent-session cookie", async () => {
    const res = await POST(req({ pin: "8264" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ari_parent=");
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
    expect(cookie).not.toContain("8264");
    // BUG-FIX-LOG 2026-07-11: outside production the cookie must NOT be
    // Secure — on http://localhost the browser drops Secure cookies and the
    // PIN gate re-prompts forever.
    expect(cookie.toLowerCase()).not.toContain("secure");
  });

  it("V.3 wrong PIN → 401 with attemptsLeft, no cookie", async () => {
    const res = await POST(req({ pin: "1112" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "wrong_pin", attemptsLeft: MAX_PIN_ATTEMPTS - 1 });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it(`V.4 ${MAX_PIN_ATTEMPTS} wrong PINs → 429 with unlockAt; the CORRECT pin still fails while locked`, async () => {
    let res: Response = new Response();
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) res = await POST(req({ pin: "1112" }));
    expect(res.status).toBe(429);
    const { unlockAt } = await res.json();
    expect(unlockAt).toBeGreaterThan(Date.now());
    expect(unlockAt).toBeLessThanOrEqual(Date.now() + LOCKOUT_MS + 1000);
    const correct = await POST(req({ pin: "8264" }));
    expect(correct.status).toBe(429);
  });

  it("V.5 no PIN set on the account → 404 not_set (client shows the set flow)", async () => {
    rows.delete(ACCOUNT);
    const res = await POST(req({ pin: "8264" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_set");
  });

  it("V.6 malformed body → 400, never a crash", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    const res2 = await POST({ json: async () => { throw new Error("bad json"); } } as never);
    expect(res2.status).toBe(400);
  });
});
