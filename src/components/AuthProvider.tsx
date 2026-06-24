"use client";
// Client wrapper for Auth.js's SessionProvider so client components (Sidebar, the gate modal)
// can read the session via useSession(). Presentational shell only — no data fetching here.

import { SessionProvider } from "next-auth/react";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
