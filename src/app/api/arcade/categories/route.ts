// [api/arcade/categories] GET — the LIVE catalog taxonomy for the publish
// picker (owner ask 2026-07-26: categories are admin-extendable platform-
// side). Proxies the platform's public /api/categories server-side (no CORS,
// no platform hostname in the client) and NEVER fails: any problem returns
// the baked base list, so the picker always has chips.

import { NextResponse } from "next/server";
import { GAME_CATEGORIES, sanitizeCategories } from "@/lib/game-categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";
const TIMEOUT_MS = 5000;

export async function GET(): Promise<NextResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/categories`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { categories?: unknown };
      const clean = sanitizeCategories(data.categories);
      if (clean) return NextResponse.json({ categories: clean });
    }
  } catch {
    /* platform unreachable — fall through to the baked list */
  } finally {
    clearTimeout(timer);
  }
  return NextResponse.json({ categories: [...GAME_CATEGORIES] });
}
