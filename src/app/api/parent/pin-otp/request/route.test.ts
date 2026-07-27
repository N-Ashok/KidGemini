/** Gate tests for the PIN-reset OTP request (BUG-FIX-LOG 2026-07-27): any
 *  signed-in session may request one (no freshness requirement — the OTP
 *  itself IS the proof), cooldown/daily-cap enforced, never persists a slot
 *  for a send that failed to deliver. AUTH CODE — fail closed. */
import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import { SignJWT } from "jose";
import type { ParentPinOtpRecord } from "@/types/parent-auth.types";

const cookieJar: { token: string } = { token: "" };
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      name === "ariantra_session" && cookieJar.token ? { value: cookieJar.token } : undefined,
  }),
}));
vi.mock("server-only", () => ({}));

const rows = new Map<string, ParentPinOtpRecord>();
vi.mock("@/lib/db", () => ({
  SqliteParentPinOtpStore: class {
    get(id: string) {
      return rows.get(id) ?? null;
    }
    put(r: ParentPinOtpRecord) {
      rows.set(r.accountId, r);
    }
  },
}));

let sendResult = true;
const sendCalls: Array<{ email: string; code: string }> = [];
vi.mock("@/lib/parent-pin-otp-bridge", () => ({
  sendParentPinOtpEmail: (email: string, code: string) => {
    sendCalls.push({ email, code });
    return Promise.resolve(sendResult);
  },
}));

import { POST } from "./route";

const SECRET = "test-secret-long-enough-0123456789";
const OLD = process.env.AUTH_JWT_SECRET;
process.env.AUTH_JWT_SECRET = SECRET;
afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD;
});

async function sessionToken(email = "parent@example.com"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "session", email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("p-1")
    .setIssuer("ariantra")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

beforeEach(() => {
  rows.clear();
  sendCalls.length = 0;
  sendResult = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/parent/pin-otp/request", () => {
  it("R.1 signed out → 401, nothing sent", async () => {
    cookieJar.token = "";
    expect((await POST()).status).toBe(401);
    expect(sendCalls).toHaveLength(0);
  });

  it("R.2 signed in, no freshness required (old bug: this used to demand a login within 5 min) → 200", async () => {
    cookieJar.token = await sessionToken();
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.maskedEmail).toBe("p*****@example.com");
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.email).toBe("parent@example.com");
    expect(sendCalls[0]!.code).toMatch(/^\d{6}$/);
  });

  it("R.3 code is never returned to the client, only sent", async () => {
    cookieJar.token = await sessionToken();
    const res = await POST();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(sendCalls[0]!.code);
  });

  it("R.4 resend within the cooldown → 429, no second send", async () => {
    cookieJar.token = await sessionToken();
    await POST();
    const res = await POST();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("cooldown");
    expect(sendCalls).toHaveLength(1);
  });

  it("R.5 email delivery failure → 502, and the slot is NOT persisted (doesn't burn the cooldown)", async () => {
    cookieJar.token = await sessionToken();
    sendResult = false;
    const res = await POST();
    expect(res.status).toBe(502);
    expect(rows.size).toBe(0);
  });

  it("R.6 masks the local part correctly for a single-character mailbox", async () => {
    cookieJar.token = await sessionToken("a@example.com");
    const res = await POST();
    expect((await res.json()).maskedEmail).toBe("*@example.com");
  });
});
