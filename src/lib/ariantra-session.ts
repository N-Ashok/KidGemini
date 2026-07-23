// SSO session verification (PURE — no Next imports, per CLAUDE.md §4, so it
// unit-tests plain). Turns a platform-minted `ariantra_session` JWT into an
// Ari identity, or null — fail closed. The cookie is issued by
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
  /** JWT iat (seconds) — lets PIN set/reset demand a FRESH login (§7). */
  issuedAt?: number;
  /** Verified-adult claim (PRD-BIBLE-TEACHER). TRUE only when the platform set
   *  `adult:true` after a self-declared adult age gate; absent/false/garbage all
   *  read as false. Gates the bible-teacher persona (resolvePersona is the
   *  fail-closed consumer). */
  adult: boolean;
}

/** Re-auth gate: a session minted within the last 5 minutes. The kid holding
 *  a parent's live-but-old session must NOT reach PIN set/reset; missing iat
 *  fails closed. PRD-PARENT-AUTH-ALERT-SCOPING §7. */
export const FRESH_SESSION_MAX_AGE_S = 5 * 60;

export function isFreshSession(
  session: Pick<AriantraSession, "issuedAt"> | null,
  nowMs: number,
): boolean {
  if (!session || typeof session.issuedAt !== "number") return false;
  return nowMs / 1000 - session.issuedAt <= FRESH_SESSION_MAX_AGE_S;
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
      ...(typeof payload.iat === "number" ? { issuedAt: payload.iat } : {}),
      adult: payload.adult === true, // fail closed — only an explicit true counts
    };
  } catch {
    return null; // expired / tampered / wrong secret / not a JWT — all fail closed
  }
}

