"use client";
// SSO client session state — drop-in replacement for next-auth/react's
// useSession/signIn/signOut (same names/shapes, so swapping is an import-line
// change). Session truth lives in the shared ariantra_session cookie; this
// hook just asks our /api/session who we are.

import { useEffect, useState } from "react";

const LOGIN_URL =
  process.env.NEXT_PUBLIC_ARIANTRA_LOGIN_URL ??
  (process.env.NODE_ENV === "development"
    ? "http://localhost:3000/login" // platform dev server, by local convention
    : "https://studio.ariantra.com/login");

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

export interface SessionData {
  /** image is always null here (the SSO session carries no avatar) — kept for
   *  next-auth API compatibility so consumers don't need changes. */
  user: { name: string | null; email: string | null; image?: string | null };
}

export function useSession(): { status: SessionStatus; data: SessionData | null } {
  const [state, setState] = useState<{ status: SessionStatus; data: SessionData | null }>({
    status: "loading",
    data: null,
  });

  useEffect(() => {
    let alive = true;
    fetch("/api/session")
      .then((r) => r.json())
      .then((d: { user: SessionData["user"] | null }) => {
        if (!alive) return;
        setState(d.user ? { status: "authenticated", data: { user: d.user } } : { status: "unauthenticated", data: null });
      })
      .catch(() => alive && setState({ status: "unauthenticated", data: null }));
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/** Send the user to the central Ariantra login; they come straight back. */
export function signIn(): void {
  window.location.assign(`${LOGIN_URL}?returnTo=${encodeURIComponent(window.location.href)}`);
}

/** Clear the shared cookie via our own first-party /api/logout (no CORS —
 *  the domain cookie is clearable from any *.ariantra.com), then reload. */
export function signOut(): void {
  void fetch("/api/logout", { method: "POST" })
    .catch(() => {})
    .finally(() => window.location.reload());
}
