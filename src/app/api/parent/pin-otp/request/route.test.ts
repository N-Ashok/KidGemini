/** Gate tests for the PIN-reset OTP request (BUG-FIX-LOG 2026-07-27): any
 *  signed-in session may request one (no freshness requirement — the OTP
 *  itself IS the proof), cooldown/daily-cap enforced, never persists a slot
 *  for a send that failed to deliver. AUTH CODE — fail closed.
 *
 *  Redesigned 2026-08-08 (docs/BUG-FIX-LOG.md "parent-PIN OTP false
 *  no-email"): this route no longer gates on `session.email` — a
 *  username/password login's SSO session never carries that claim, so the
 *  old gate reported "no email on file" for accounts that genuinely had one.
 *  The bridge now resolves the real contact email server-side by
 *  `session.playerId`; this route only forwards its structured result. */
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

type BridgeResult = { ok: true; maskedEmail: string } | { ok: false; error: "no_email" | "send_failed" };
let bridgeResult: BridgeResult = { ok: true, maskedEmail: "p****@example.com" };
const sendCalls: Array<{ playerId: string; code: string }> = [];
vi.mock("@/lib/parent-pin-otp-bridge", () => ({
  sendParentPinOtpEmail: (playerId: string, code: string) => {
    sendCalls.push({ playerId, code });
    return Promise.resolve(bridgeResult);
  },
}));

import { POST } from "./route";

const SECRET = "test-secret-long-enough-0123456789";
const OLD = process.env.AUTH_JWT_SECRET;
process.env.AUTH_JWT_SECRET = SECRET;
afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD;
});

/** `email` omitted by default — a username/password login's real session
 *  shape, and exactly the case this fix is for (BUG-FIX-LOG 2026-08-08). */
async function sessionToken(opts: { sub?: string; email?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { typ: "session" };
  if (opts.email) claims.email = opts.email;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(opts.sub ?? "player-1")
    .setIssuer("ariantra")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

beforeEach(() => {
  rows.clear();
  sendCalls.length = 0;
  bridgeResult = { ok: true, maskedEmail: "p****@example.com" };
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
    expect(data.maskedEmail).toBe("p****@example.com");
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.playerId).toBe("player-1");
    expect(sendCalls[0]!.code).toMatch(/^\d{6}$/);
  });

  // THE bug (docs/BUG-FIX-LOG.md 2026-08-08): a session with NO email claim
  // — exactly what a plain username/password login produces — must still be
  // able to request a code, because the bridge resolves the real address
  // server-side by playerId, not from this claim.
  it("R.2b a session with NO email claim (username/password login) still requests successfully — the old bug", async () => {
    cookieJar.token = await sessionToken({ sub: "player-nopwd-email" }); // no `email` passed
    const res = await POST();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sendCalls[0]!.playerId).toBe("player-nopwd-email");
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

  it("R.5 transport/send failure → 502, and the slot is NOT persisted (doesn't burn the cooldown)", async () => {
    cookieJar.token = await sessionToken();
    bridgeResult = { ok: false, error: "send_failed" };
    const res = await POST();
    expect(res.status).toBe(502);
    expect(rows.size).toBe(0);
  });

  // R.6 replaces the old "masks the local part correctly" test — masking now
  // happens on the platform (it's the only holder of the plaintext), so this
  // route just forwards whatever maskedEmail the bridge returned.
  it("R.6 forwards the bridge's maskedEmail verbatim", async () => {
    bridgeResult = { ok: true, maskedEmail: "*@example.com" };
    cookieJar.token = await sessionToken();
    const res = await POST();
    expect((await res.json()).maskedEmail).toBe("*@example.com");
  });

  // The genuine "no email on file" case (a real gap, not a bug): the account
  // truly has no owner-profile contact email saved anywhere. Still a clean
  // 422 with an actionable message — not a dead end.
  it("R.7 the platform genuinely has no contact email on file → 422 no_email, not persisted", async () => {
    cookieJar.token = await sessionToken();
    bridgeResult = { ok: false, error: "no_email" };
    const res = await POST();
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe("no_email");
    expect(data.message).toMatch(/studio/i); // points somewhere actionable, not a dead end
    expect(rows.size).toBe(0);
  });
});
