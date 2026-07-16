/** Gate tests for the NEW reverse-direction bridge (Phase 5, PRD-MULTIPLAYER.md
 *  Open Decision #1, resolved: platform calls kidgemini, not the other way
 *  around). Auth mirrors arcade/publish's shared-secret gate, inverted:
 *  `x-admin-secret` must equal AUTH_JWT_SECRET, and the caller forwards the
 *  raw `ariantra_session` JWT so kidgemini derives the SAME `userId` its
 *  `payments` table already uses (no separate identity-mapping to get wrong). */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { SignJWT } from "jose";

const latestForUserMock = vi.fn();
vi.mock("@/lib/db", () => ({
  SqlitePaymentStore: class {
    latestForUser(...args: unknown[]) {
      return latestForUserMock(...args);
    }
  },
}));

import { POST } from "./route";

const SECRET = "test-secret-long-enough-0123456789";
const OLD = { secret: process.env.AUTH_JWT_SECRET };
process.env.AUTH_JWT_SECRET = SECRET;

afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD.secret;
});

async function sessionToken(email = "kid@example.com"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "session", email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("player-1")
    .setIssuer("ariantra")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

const req = (body: unknown, secret = SECRET) => ({
  json: async () => body,
  headers: { get: (k: string) => (k.toLowerCase() === "x-admin-secret" ? secret : null) },
}) as never;

beforeEach(() => {
  latestForUserMock.mockReset();
});

describe("POST /api/entitlement/check", () => {
  it("E.1 wrong shared secret → 403, payments never queried", async () => {
    const res = await POST(req({ sessionToken: await sessionToken() }, "wrong"));
    expect(res.status).toBe(403);
    expect(latestForUserMock).not.toHaveBeenCalled();
  });

  it("E.2 missing/invalid sessionToken → 401", async () => {
    expect((await POST(req({}))).status).toBe(401);
    expect((await POST(req({ sessionToken: "not-a-jwt" }))).status).toBe(401);
    expect(latestForUserMock).not.toHaveBeenCalled();
  });

  it("E.3 a paid, unexpired account → entitled: true, looked up by the SAME userId payments.userId uses", async () => {
    latestForUserMock.mockReturnValue({ planKey: "explorer", status: "paid", periodEndsAt: Date.now() + 100_000 });
    const res = await POST(req({ sessionToken: await sessionToken("kid@example.com") }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ entitled: true, planKey: "explorer" });
    expect(latestForUserMock).toHaveBeenCalledWith("user:kid@example.com");
  });

  it("E.4 an expired paid record → entitled: false", async () => {
    latestForUserMock.mockReturnValue({ planKey: "explorer", status: "paid", periodEndsAt: Date.now() - 1000 });
    const res = await POST(req({ sessionToken: await sessionToken() }));
    expect((await res.json()).entitled).toBe(false);
  });

  it("E.5 no payment record at all → entitled: false, not a 404/error", async () => {
    latestForUserMock.mockReturnValue(null);
    const res = await POST(req({ sessionToken: await sessionToken() }));
    expect(res.status).toBe(200);
    expect((await res.json()).entitled).toBe(false);
  });
});
