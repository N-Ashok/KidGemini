// POST /api/usage — OPERATOR analytics (token usage, cost, geo, per-user, raw
// events). Gated by ADMIN_SECRET in the request body: no query params (they
// land in access logs), no fallback (unset → 503, never open), and completely
// independent of the parent PIN (PRD-PARENT-AUTH-ALERT-SCOPING D2/§9).
// timingSafeEqual: a string compare would leak the secret byte-by-byte.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { SqliteUsageStore } from "@/lib/db";

export const runtime = "nodejs";

const usage = new SqliteUsageStore();
const DAY_MS = 24 * 60 * 60 * 1000;

function secretMatches(candidate: string, actual: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error("[api/usage] ADMIN_SECRET is not set — admin dashboard unavailable (fail closed)");
    return NextResponse.json({ error: "admin_unavailable" }, { status: 503 });
  }

  let body: { secret?: unknown; days?: unknown; detail?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.secret !== "string" || !secretMatches(body.secret, adminSecret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const days = Number(body.days ?? 30);
  const since = Date.now() - (Number.isFinite(days) && days > 0 ? days : 30) * DAY_MS;

  const summary = usage.summarizeSince(since);
  const events = body.detail === true ? usage.listSince(since) : undefined;
  return NextResponse.json({ days, summary, events });
}
