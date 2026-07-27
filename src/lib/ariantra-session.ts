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
  /** The PLATFORM's real ledger key (JWT `sub`) — distinct from `userId`
   *  above, which is a derived display/db string. Needed wherever Ari calls
   *  back into the platform's own identity space (e.g. crediting a Sparks
   *  purchase from a webhook that has no live session to replay — Phase 5
   *  payments, billing/verify + webhook routes). */
  playerId: string;
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
      playerId: payload.sub,
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(typeof payload.iat === "number" ? { issuedAt: payload.iat } : {}),
      adult: payload.adult === true, // fail closed — only an explicit true counts
    };
  } catch {
    return null; // expired / tampered / wrong secret / not a JWT — all fail closed
  }
}

