// Parent-session cookie token (PRD-PARENT-AUTH-ALERT-SCOPING §8): a short-
// lived JWT minted by kidgemini after a correct PIN. Alert reads and publish
// approvals trust THIS, never a raw PIN. AUTH CODE — tests first, fail closed.
import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import {
  mintParentSession,
  verifyParentSession,
  parentSessionCookieAttrs,
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_S,
} from "./parent-session";

const SECRET = "test-secret-test-secret-test-secret!";
const key = new TextEncoder().encode(SECRET);

describe("parent session token", () => {
  it("round-trips: mint then verify returns the account id", async () => {
    const token = await mintParentSession("user:parent@example.com", SECRET);
    expect(await verifyParentSession(token, SECRET)).toBe("user:parent@example.com");
  });

  it("has a ~30 minute TTL and a stable cookie name", () => {
    expect(PARENT_SESSION_TTL_S).toBe(30 * 60);
    expect(PARENT_SESSION_COOKIE).toBe("kidgemini_parent");
  });

  it("rejects an ariantra_session JWT (typ 'session' ≠ 'parent') — a kid's SSO cookie is NOT parent proof", async () => {
    const sso = await new SignJWT({ typ: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("ariantra")
      .setSubject("user:parent@example.com")
      .setExpirationTime("30m")
      .sign(key);
    expect(await verifyParentSession(sso, SECRET)).toBeNull();
  });

  it("rejects tampered/expired/wrong-secret tokens — all fail closed", async () => {
    const token = await mintParentSession("user:p@e.com", SECRET);
    expect(await verifyParentSession(token + "x", SECRET)).toBeNull();
    expect(await verifyParentSession(token, "some-other-secret-value-here!!")).toBeNull();
    expect(await verifyParentSession("", SECRET)).toBeNull();
    const expired = await new SignJWT({ typ: "parent" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("ariantra")
      .setSubject("user:p@e.com")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    expect(await verifyParentSession(expired, SECRET)).toBeNull();
  });

  // BUG-FIX-LOG 2026-07-11: both PIN routes hardcoded `secure: true`, so on
  // http://localhost the browser dropped the cookie the moment it was set —
  // the PIN verified, then the gate re-prompted forever. Secure must track
  // the environment (same convention as the platform's SSO cookie).
  it("cookie attrs: Secure in production, NOT Secure in dev (http localhost)", () => {
    expect(parentSessionCookieAttrs(true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: PARENT_SESSION_TTL_S,
      path: "/",
    });
    expect(parentSessionCookieAttrs(false).secure).toBe(false);
    // Everything except Secure is identical — dev must not weaken the rest.
    expect(parentSessionCookieAttrs(false)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  });
});
