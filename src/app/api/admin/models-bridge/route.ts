// POST /api/admin/models-bridge — server-to-server bridge Platform's
// `/api/studio/admin/models-proxy` calls to power the "3D Models" tab in
// `/studio/admin` (owner ask 2026-08-21: "i need a place to look at the ability
// of each 3d model and what we can do with each model in the game").
//
// Deliberately the SAME contract as the sibling `usage-bridge`: `x-admin-secret`
// checked against the shared AUTH_JWT_SECRET, constant-time compare, fail-closed
// 503 when unset. Machine-to-machine only; never reachable from a browser.
//
// The payload is public information — model names, licences, clip names, all of
// which already ship inside every generated game — but the route stays admin-
// gated anyway: it is an internal tool, and a catalogue of everything we own is
// not something to hand out for free.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { modelCatalogue } from "@/lib/assets/model-catalogue";

export const runtime = "nodejs";

function secretMatches(candidate: string, actual: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const sharedSecret = process.env.AUTH_JWT_SECRET;
  if (!sharedSecret) {
    console.error("[api/admin/models-bridge] AUTH_JWT_SECRET is not set — bridge unavailable (fail closed)");
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 503 });
  }

  const header = req.headers.get("x-admin-secret");
  if (!header || !secretMatches(header, sharedSecret)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const models = modelCatalogue();
  return NextResponse.json({
    models,
    summary: {
      total: models.length,
      animated: models.filter((m) => m.clips.length > 0).length,
      static: models.filter((m) => m.clips.length === 0).length,
      retired: models.filter((m) => m.retired).length,
    },
  });
}
