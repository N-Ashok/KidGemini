// Who owns this request's chats — the SAME identity key the usage gate uses:
// the SSO session's userId (user:<email>) when signed in, else the httpOnly
// guest device cookie (guest:<uuid>). Null = brand-new visitor with no chats
// yet (the cookie is minted by /api/chat on the first message). Server-only.

import "server-only";
import type { NextRequest } from "next/server";
import { getAriantraSession } from "./ariantra-session.server";
import { GUEST_COOKIE } from "./gate.config";

export async function resolveChatUser(req: NextRequest): Promise<string | null> {
  try {
    const session = await getAriantraSession();
    if (session?.userId) return session.userId;
  } catch {
    /* auth misconfigured — fail safe to the guest cookie, same as /api/chat */
  }
  return req.cookies.get(GUEST_COOKIE)?.value ?? null;
}
