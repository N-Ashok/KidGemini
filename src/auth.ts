// Auth.js (NextAuth v5) — Google sign-in. Server-only; the gate in api/chat uses `auth()`
// to tell a signed-in user from a guest. Secrets (AUTH_SECRET, AUTH_GOOGLE_ID,
// AUTH_GOOGLE_SECRET) live in .env.local and are read by Auth.js automatically.
// Single responsibility: configure authentication; it does not gate or persist usage.

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  // Behind a proxy / custom domain (kidgemini.ariantra.com) Auth.js needs to trust the host.
  trustHost: true,
});
