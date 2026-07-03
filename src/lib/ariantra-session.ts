// SSO session verification (PURE — no Next imports, per CLAUDE.md §4, so it
// unit-tests plain). Turns a platform-minted `ariantra_session` JWT into a
// kidgemini identity, or null — fail closed. The cookie is issued by
// Ariantra-Platform (src/lib/auth/tokens.ts) on Domain=.ariantra.com; both
// apps share AUTH_JWT_SECRET. Request-cookie reading lives in
// ariantra-session.server.ts.

import { jwtVerify } from "jose";

export const SESSION_COOKIE = "ariantra_session";
const ISSUER = "ariantra";

export interface AriantraSession {
  /** Stable per-user key for db rows. Email-first for continuity with the
   *  pre-SSO Google accounts (`user:<email>`), then name, then playerId. */
  userId: string;
  email?: string;
  name?: string;
}

/** Pure verification — unit-tested; no Next imports so vitest runs it plain. */
export async function verifyAriantraSession(
  token: string,
  secret: string,
): Promise<AriantraSession | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: ISSUER,
    });
    if (payload.typ !== "session") return null;
    if (typeof payload.sub !== "string" || payload.sub === "") return null;
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    return {
      userId: `user:${email ?? name ?? payload.sub}`,
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
    };
  } catch {
    return null; // expired / tampered / wrong secret / not a JWT — all fail closed
  }
}

