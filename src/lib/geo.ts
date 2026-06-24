// Resolve a request's client IP and (best-effort) geo. Single responsibility.
// In production behind a proxy/CDN, geo headers (e.g. x-vercel-ip-city) are populated;
// locally these are null, which is fine. Server-only.

import "server-only";
import type { NextRequest } from "next/server";
import type { GeoInfo } from "@/types/usage.types";

export function resolveGeo(req: NextRequest): GeoInfo {
  const h = req.headers;
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    h.get("x-real-ip") ??
    null;
  return {
    ip,
    country: h.get("x-vercel-ip-country") ?? null,
    region: h.get("x-vercel-ip-country-region") ?? null,
    city: h.get("x-vercel-ip-city") ?? null,
  };
}
