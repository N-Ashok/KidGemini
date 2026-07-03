// Resolve the signed-in user's stable id. Single responsibility: identity, nothing else.
// Mirrors the id shape used by /api/chat (`user:<email>`), so a user is the same key everywhere.
// Never throws — if auth is misconfigured we treat the caller as signed-out (fail-closed).

import { auth } from "@/auth";

export async function resolveUserId(): Promise<string | null> {
  try {
    const session = await auth();
    if (!session?.user) return null;
    return `user:${session.user.email ?? session.user.name ?? "google"}`;
  } catch {
    return null;
  }
}
