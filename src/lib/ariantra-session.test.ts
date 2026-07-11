/**
 * SSO session verification — kidgemini accepts the platform-minted
 * `ariantra_session` cookie (Ariantra-Platform src/lib/auth/tokens.ts). These
 * tests pin the contract: HS256 + issuer 'ariantra' + typ 'session', fail-closed
 * null on anything else. Auth code is NEVER untested (CLAUDE.md §7.4).
 */
import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import { verifyAriantraSession, isFreshSession, SESSION_COOKIE } from "./ariantra-session";

const SECRET = "shared-sso-secret-long-enough-0123456789";
const key = new TextEncoder().encode(SECRET);

async function mint(overrides: Record<string, unknown> = {}, opts: { secret?: Uint8Array; exp?: number; issuer?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "session", tv: 0, email: "kid@example.com", name: "Kid", ...overrides })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject((overrides.sub as string) ?? "player-1")
    .setIssuer(opts.issuer ?? "ariantra")
    .setIssuedAt(now)
    .setExpirationTime(opts.exp ?? now + 3600)
    .sign(opts.secret ?? key);
}

describe("verifyAriantraSession", () => {
  it("V.1 accepts a valid session and keys userId by email (history continuity)", async () => {
    const s = await verifyAriantraSession(await mint(), SECRET);
    expect(s).toMatchObject({ userId: "user:kid@example.com", email: "kid@example.com", name: "Kid" });
    expect(typeof s?.issuedAt).toBe("number"); // freshness gate needs iat
  });

  it("V.8 exposes issuedAt so PIN set/reset can demand a FRESH login (re-auth gate)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = await verifyAriantraSession(await mint(), SECRET);
    expect(isFreshSession(fresh, Date.now())).toBe(true);
    const stale = { ...fresh!, issuedAt: now - 6 * 60 };
    expect(isFreshSession(stale, Date.now())).toBe(false);
    // No iat at all → NOT fresh (fail closed).
    expect(isFreshSession({}, Date.now())).toBe(false); // no iat at all
    expect(isFreshSession(null, Date.now())).toBe(false);
  });

  it("V.2 falls back to name, then playerId, when email is absent", async () => {
    const byName = await verifyAriantraSession(await mint({ email: undefined }), SECRET);
    expect(byName?.userId).toBe("user:Kid");
    const byId = await verifyAriantraSession(await mint({ email: undefined, name: undefined }), SECRET);
    expect(byId?.userId).toBe("user:player-1");
  });

  it("V.3 rejects non-session token types (access/refresh must not work here)", async () => {
    expect(await verifyAriantraSession(await mint({ typ: "access" }), SECRET)).toBeNull();
    expect(await verifyAriantraSession(await mint({ typ: "refresh" }), SECRET)).toBeNull();
  });

  it("V.4 rejects expired tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyAriantraSession(await mint({}, { exp: now - 10 }), SECRET)).toBeNull();
  });

  it("V.5 rejects a wrong secret or tampered token (fail-closed)", async () => {
    const other = new TextEncoder().encode("a-different-secret-value-9876543210-xyz");
    expect(await verifyAriantraSession(await mint({}, { secret: other }), SECRET)).toBeNull();
    const t = await mint();
    expect(await verifyAriantraSession(t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa"), SECRET)).toBeNull();
  });

  it("V.6 rejects a wrong issuer, empty token, and garbage", async () => {
    expect(await verifyAriantraSession(await mint({}, { issuer: "not-ariantra" }), SECRET)).toBeNull();
    expect(await verifyAriantraSession("", SECRET)).toBeNull();
    expect(await verifyAriantraSession("not.a.jwt", SECRET)).toBeNull();
  });

  it("V.7 cookie name matches the platform's", () => {
    expect(SESSION_COOKIE).toBe("ariantra_session");
  });
});
