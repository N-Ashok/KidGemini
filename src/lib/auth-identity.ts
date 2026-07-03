// Resolve the signed-in user's stable id. Single responsibility: identity, nothing else.
// Source of truth is the shared Ariantra SSO session (ariantra_session cookie —
// see ariantra-session.ts). Email-first keying preserves the pre-SSO rows
// (`user:<email>` from the Google-login era). Never throws — unauthenticated
// or misconfigured ⇒ null (callers fail closed).

import "server-only";
import { getAriantraSession } from "./ariantra-session.server";

export async function resolveUserId(): Promise<string | null> {
  const session = await getAriantraSession();
  return session?.userId ?? null;
}
