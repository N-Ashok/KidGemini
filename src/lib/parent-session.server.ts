// Server half of parent-session verification: read the `kidgemini_parent`
// cookie off the current request (pure logic in parent-session.ts).

import "server-only";
import { cookies } from "next/headers";
import { PARENT_SESSION_COOKIE, verifyParentSession } from "./parent-session";

/** The PIN-verified parent's account id for this request, or null. */
export async function getVerifiedParentAccount(): Promise<string | null> {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    console.error("[auth] AUTH_JWT_SECRET is not set — parent sessions rejected (fail closed)");
    return null;
  }
  const token = cookies().get(PARENT_SESSION_COOKIE)?.value ?? "";
  return verifyParentSession(token, secret);
}
