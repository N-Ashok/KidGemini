export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// [api/logout] POST — clear the shared ariantra_session cookie FIRST-PARTY
// (kidgemini is on .ariantra.com, so it can expire the domain cookie itself —
// no cross-origin call to the platform needed). Signs out every surface.

import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/ariantra-session";

export async function POST(): Promise<NextResponse> {
  const domain =
    process.env.SESSION_COOKIE_DOMAIN ??
    (process.env.NODE_ENV === "production" ? ".ariantra.com" : undefined);
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (domain) parts.push(`Domain=${domain}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  const res = NextResponse.json({ ok: true });
  res.headers.append("set-cookie", parts.join("; "));
  return res;
}
