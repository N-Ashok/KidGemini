// Server half of SSO session verification: read the `ariantra_session` cookie
// off the current request and verify it (pure logic in ariantra-session.ts).

import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifyAriantraSession, type AriantraSession } from "./ariantra-session";

export type { AriantraSession };

/** Read + verify the session cookie of the current request (API routes/RSC). */
export async function getAriantraSession(): Promise<AriantraSession | null> {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    console.error("[auth] AUTH_JWT_SECRET is not set — all sessions rejected (fail closed)");
    return null;
  }
  const token = cookies().get(SESSION_COOKIE)?.value ?? "";
  return verifyAriantraSession(token, secret);
}
