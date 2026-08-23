// POST /api/admin/help-bridge — server-to-server bridge Platform's
// `/api/studio/admin/sos-proxy` calls to power the SOS tab in `/studio/admin`
// (owner ask 2026-08-23: "kidgemini also has admin tab and sos tab which also
// need to be surfaced", and "i need ways to do functionally easy").
//
// WHAT THIS BUYS, and it is the whole point: the browser route beside this one
// makes the operator paste ADMIN_SECRET into a form every time. Through this
// bridge the admin is already signed in to the Studio, so the queue is one
// click from the Studio page and no secret is ever typed or pasted.
//
// Same contract as the sibling `usage-bridge` / `models-bridge`:
// `x-admin-secret` header checked against the SHARED AUTH_JWT_SECRET,
// constant-time compare, fail-closed 503 when unset. Machine-to-machine only.
//
// It runs the SAME lib/help-admin actions as the browser route — including the
// free-text screening, the guests-are-canned-only rule and the mandatory
// parent mirror. Reaching the queue a second way must never mean a second,
// weaker set of rules.

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
  const sharedSecret = process.env.AUTH_JWT_SECRET;
  if (!sharedSecret) {
    console.error("[api/admin/help-bridge] AUTH_JWT_SECRET is not set — bridge unavailable (fail closed)");
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 503 });
  }

  const header = req.headers.get("x-admin-secret");
  if (!header || !secretMatches(header, sharedSecret)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // The body carries the ACTION only. Any `secret` a caller sends is dropped:
  // this route's auth is the header, and letting a body field travel on would
  // invite the two gates being confused for one another.
  delete body.secret;

  const { status, json } = await handleHelpAction(body, Date.now());
  return NextResponse.json(json, { status });
}
