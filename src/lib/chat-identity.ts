// Who owns this request's chats — the SAME identity key the usage gate uses:
// the SSO session's userId (user:<email>) when signed in, else the httpOnly
// guest device cookie (guest:<uuid>). Null = brand-new visitor with no chats
// yet (the cookie is minted by /api/chat on the first message). Server-only.

import "server-only";
import type { NextRequest } from "next/server";
import { getAriantraSession } from "./ariantra-session.server";
import { GUEST_COOKIE, GUEST_COOKIE_LEGACY } from "./gate.config";

/** The guest identity, checking the current cookie name first and falling
 *  back to the pre-rename name (2026-07-17) so a returning device isn't
 *  treated as brand-new. Read-only — callers that also WRITE cookies (only
 *  /api/chat does) handle re-persisting under the new name themselves. */
export function readGuestId(req: NextRequest): string | undefined {
  return req.cookies.get(GUEST_COOKIE)?.value ?? req.cookies.get(GUEST_COOKIE_LEGACY)?.value;
}

export async function resolveChatUser(req: NextRequest): Promise<string | null> {
  try {
    const session = await getAriantraSession();
    if (session?.userId) return session.userId;
  } catch {
    /* auth misconfigured — fail safe to the guest cookie, same as /api/chat */
  }
  return readGuestId(req) ?? null;
}
