// POST /api/admin/help — the operator side of the 🆘 queue
// (docs/PRD-COMMUNITY-HELP.md §3.7: kidgemini-local, because the tickets,
// error reports and artifacts all live in kidgemini's SQLite).
//
// Auth is the SAME shape as /api/usage: ADMIN_SECRET in the POST body (never a
// query param — those land in access logs), timing-safe compare, and unset →
// 503 rather than open. No new credential (PRD §6).
//
// The ACTIONS themselves (list / reply / source) moved to lib/help-admin.ts on
// 2026-08-23 so this route and the server-to-server `help-bridge` — which the
// Studio admin console's SOS tab calls — run one implementation rather than
// two. This file is now purely the browser-facing gate.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { handleHelpAction } from "@/lib/help-admin";

export const runtime = "nodejs";

function secretMatches(candidate: string, actual: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error("[api/admin/help] ADMIN_SECRET is not set — help queue unavailable (fail closed)");
    return NextResponse.json({ error: "admin_unavailable" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.secret !== "string" || !secretMatches(body.secret, adminSecret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { status, json } = await handleHelpAction(body, Date.now());
  return NextResponse.json(json, { status });
}
