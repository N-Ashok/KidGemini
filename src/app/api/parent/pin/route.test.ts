/** Gate tests for PIN set/reset: a valid OTP is required (D6 format rules
 *  unchanged), fail-closed. BUG-FIX-LOG 2026-07-27 REPLACED the old
 *  fresh-session gate with this — see pin-otp/request/route.test.ts for the
 *  request side and parent-pin-otp.test.ts for the pure verify logic this
 *  route delegates to. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { SignJWT } from "jose";
import type { ParentAuthRecord, ParentPinOtpRecord } from "@/types/parent-auth.types";
import { hashOtpCode, OTP_TTL_MS } from "@/lib/parent-pin-otp";

const cookieJar: { token: string } = { token: "" };
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      name === "ariantra_session" && cookieJar.token ? { value: cookieJar.token } : undefined,
  }),
}));
vi.mock("server-only", () => ({}));

const pinRows = new Map<string, ParentAuthRecord>();
const otpRows = new Map<string, ParentPinOtpRecord>();
vi.mock("@/lib/db", () => ({
  SqliteParentAuthStore: class {
    get(id: string) {
      return pinRows.get(id) ?? null;
    }
    put(r: ParentAuthRecord) {
      pinRows.set(r.accountId, r);
    }
    recordAttempt() {}
  },
  SqliteParentPinOtpStore: class {
    get(id: string) {
      return otpRows.get(id) ?? null;
    }
    put(r: ParentPinOtpRecord) {
      otpRows.set(r.accountId, r);
    }
    recordAttempt(id: string, attempts: number) {
      const r = otpRows.get(id);
      if (r) otpRows.set(id, { ...r, attempts });
    }
    clear(id: string) {
      otpRows.delete(id);
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
const CODE = "482913";

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

function seedOtp(over: Partial<ParentPinOtpRecord> = {}) {
  const now = Date.now();
  otpRows.set(ACCOUNT, {
    accountId: ACCOUNT,
    codeHash: hashOtpCode(CODE),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    sentAt: now,
    sendCount: 1,
    windowStart: now,
    ...over,
  });
}

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => {
  pinRows.clear();
  otpRows.clear();
});

describe("POST /api/parent/pin (set/reset)", () => {
  it("S.1 signed out → 401", async () => {
    cookieJar.token = "";
    expect((await POST(req({ pin: "8264", otp: CODE }))).status).toBe(401);
    expect(pinRows.size).toBe(0);
  });

  it("S.2 no OTP ever requested → 400 otp_not_requested (old bug: this used to be a fresh-session check a kid could pass on a shared device)", async () => {
    cookieJar.token = await sessionToken();
    const res = await POST(req({ pin: "8264", otp: CODE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("otp_not_requested");
    expect(pinRows.size).toBe(0);
  });

  it("S.3 valid OTP + valid PIN → stored HASHED, parent cookie issued, OTP consumed (single-use)", async () => {
    cookieJar.token = await sessionToken();
    seedOtp();
    const res = await POST(req({ pin: "8264", otp: CODE }));
    expect(res.status).toBe(200);
    const row = pinRows.get(ACCOUNT)!;
    expect(row.pinHash).not.toContain("8264");
    expect(row.attempts).toBe(0);
    expect(res.headers.get("set-cookie")).toContain("ari_parent=");
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).not.toContain("secure");
    expect(otpRows.has(ACCOUNT)).toBe(false);
  });

  it("S.4 D6 format rules: wrong length, non-digits, trivial sequences → 422 (OTP never consumed on a rejected PIN)", async () => {
    cookieJar.token = await sessionToken();
    seedOtp();
    for (const bad of ["12", "12345", "12a4", "0000", "1234", "4321"]) {
      const res = await POST(req({ pin: bad, otp: CODE }));
      expect(res.status).toBe(422);
    }
    expect(pinRows.size).toBe(0);
    expect(otpRows.has(ACCOUNT)).toBe(true);
  });

  it("S.5 reset: an existing PIN is replaced (same OTP gate) and throttling clears", async () => {
    cookieJar.token = await sessionToken();
    seedOtp();
    await POST(req({ pin: "8264", otp: CODE }));
    const first = pinRows.get(ACCOUNT)!.pinHash;
    pinRows.set(ACCOUNT, { ...pinRows.get(ACCOUNT)!, attempts: 3, lockedUntil: Date.now() + 60_000 });
    seedOtp({ codeHash: hashOtpCode("135790") });
    const res = await POST(req({ pin: "7391", otp: "135790" }));
    expect(res.status).toBe(200);
    const row = pinRows.get(ACCOUNT)!;
    expect(row.pinHash).not.toBe(first);
    expect(row.attempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it("S.6 malformed body → 400", async () => {
    cookieJar.token = await sessionToken();
    expect((await POST(req({ pin: "8264" }))).status).toBe(400); // missing otp
    expect((await POST(req({}))).status).toBe(400);
  });

  it("S.7 wrong OTP → 401 otp_wrong with attemptsLeft, PIN untouched, code stays valid for another try", async () => {
    cookieJar.token = await sessionToken();
    seedOtp();
    const res = await POST(req({ pin: "8264", otp: "000000" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("otp_wrong");
    expect(pinRows.size).toBe(0);
    expect(otpRows.get(ACCOUNT)!.attempts).toBe(1);
  });

  it("S.8 expired OTP → 400 otp_expired", async () => {
    cookieJar.token = await sessionToken();
    seedOtp({ expiresAt: Date.now() - 1 });
    const res = await POST(req({ pin: "8264", otp: CODE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("otp_expired");
  });

  it("S.9 5 wrong OTP guesses → 429 otp_too_many_attempts, even with the right code afterward", async () => {
    cookieJar.token = await sessionToken();
    seedOtp();
    for (let i = 0; i < 5; i++) {
      await POST(req({ pin: "8264", otp: "000000" }));
    }
    const res = await POST(req({ pin: "8264", otp: CODE }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("otp_too_many_attempts");
    expect(pinRows.size).toBe(0);
  });
});
