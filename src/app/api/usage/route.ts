// POST /api/usage — OPERATOR analytics (token usage, cost, geo, per-user, raw
// events). Gated by ADMIN_SECRET in the request body: no query params (they
// land in access logs), no fallback (unset → 503, never open), and completely
// independent of the parent PIN (PRD-PARENT-AUTH-ALERT-SCOPING D2/§9).
// timingSafeEqual: a string compare would leak the secret byte-by-byte.
//
// Rollup/period-query logic lives in `@/lib/usage-report` (extracted
// 2026-07-28, Feature 5 admin consolidation) — this route now only handles
// the ADMIN_SECRET check and calls the shared builder. Kept working as-is
// (not yet removed) alongside the new `/api/admin/usage-bridge`, which the
// same function powers for Platform's `/studio/admin` Usage tab; the
// browser-facing dashboard at `/admin` + this route retire in a follow-up
// commit once that bridge is verified in prod.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { buildUsageReport } from "@/lib/usage-report";

export const runtime = "nodejs";

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

  const report = buildUsageReport({ days: body.days, detail: body.detail });
  return NextResponse.json(report);
}
