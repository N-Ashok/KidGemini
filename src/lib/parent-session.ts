// Parent-session token — PURE (no Next imports, unit-tests plain). Minted by
// /api/parent/verify-pin after a correct PIN; checked by /api/alerts and the
// Arcade publish approval. Signed with the shared AUTH_JWT_SECRET but with
// typ:"parent", so an SSO session cookie can never pass as parent proof and
// vice versa (verifyAriantraSession requires typ:"session").

import { SignJWT, jwtVerify } from "jose";

export const PARENT_SESSION_COOKIE = "ari_parent";
/** §13 Q5 — 30 min default; tune after UAT. */
export const PARENT_SESSION_TTL_S = 30 * 60;

const ISSUER = "ariantra";

export async function mintParentSession(accountId: string, secret: string): Promise<string> {
  return new SignJWT({ typ: "parent" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime(`${PARENT_SESSION_TTL_S}s`)
    .sign(new TextEncoder().encode(secret));
}

/** Cookie attributes for the parent-session cookie, shared by BOTH issuers
 *  (/api/parent/pin set-flow and /api/parent/verify-pin). Secure tracks the
 *  environment: hardcoding `secure: true` made http://localhost browsers drop
 *  the cookie the instant it was set — PIN verified, gate re-prompted forever
 *  (BUG-FIX-LOG 2026-07-11). Same convention as the platform's SSO cookie. */
export function parentSessionCookieAttrs(
  isProd: boolean = process.env.NODE_ENV === "production",
) {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: "strict" as const,
    maxAge: PARENT_SESSION_TTL_S,
    path: "/",
  };
}

/** The verified account id, or null — expired/tampered/wrong-typ all fail closed. */
export async function verifyParentSession(token: string, secret: string): Promise<string | null> {
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { issuer: ISSUER });
    if (payload.typ !== "parent") return null;
    if (typeof payload.sub !== "string" || payload.sub === "") return null;
    return payload.sub;
  } catch {
    return null;
  }
}
