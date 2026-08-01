// POST /api/parent/session/clear — deletes the ari_parent parent-session
// cookie. Called when the parent leaves the Parent area (component unmount /
// tab close), so re-entering it always asks for the PIN again — the parent
// session is scoped to "while you're in the Parent area", not a rolling TTL
// (owner decision 2026-08-01). No auth gate needed: this only ever narrows
// access (clearing a cookie can't leak anything), and it must still succeed
// for a signed-out caller/expired session so the beacon on tab-close never 401s.

import { NextResponse } from "next/server";
import { PARENT_SESSION_COOKIE } from "@/lib/parent-session";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PARENT_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
