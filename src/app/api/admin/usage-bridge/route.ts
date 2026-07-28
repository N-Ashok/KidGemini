// POST /api/admin/usage-bridge — server-to-server bridge Platform's
// `/api/studio/admin/usage-proxy` calls to power the Usage & Cost tab in
// `/studio/admin` (Feature 5, admin consolidation, 2026-07-28). Same
// server-to-server contract as the existing partner bridges
// (`parent-pin-otp`, `sparks`): `x-admin-secret` header checked against the
// SHARED AUTH_JWT_SECRET (same value as Platform's), constant-time compare,
// fail-closed 503 if unset server-side. Distinct from the legacy `/api/usage`
// route's ADMIN_SECRET (browser-facing, human-typed) — this is machine-to-
// machine only and is never reachable from a browser directly.

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
  const sharedSecret = process.env.AUTH_JWT_SECRET;
  if (!sharedSecret) {
    console.error("[api/admin/usage-bridge] AUTH_JWT_SECRET is not set — bridge unavailable (fail closed)");
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 503 });
  }

  const header = req.headers.get("x-admin-secret");
  if (!header || !secretMatches(header, sharedSecret)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { days?: unknown; detail?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const report = buildUsageReport({ days: body.days, detail: body.detail });
  return NextResponse.json(report);
}
