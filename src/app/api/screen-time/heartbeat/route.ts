// POST /api/screen-time/heartbeat — a lightweight presence ping fired by
// ScreenTimeHeartbeat.tsx while the kidgemini tab is open and visible, so
// playing an already-built game counts toward screen time the same as
// chatting (PRD-SCREEN-TIME-CAP-MVP Part B, extended 2026-07-15). Signed-in
// only; a guest ping is a no-op 200 — not an error, since heartbeats fire
// automatically in the background and a guest hasn't done anything wrong.

import { NextResponse } from "next/server";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { SqliteScreenTimeStore } from "@/lib/db";

export const runtime = "nodejs";

export async function POST() {
  const session = await getAriantraSession();
  if (!session) return NextResponse.json({ ok: true });

  try {
    const store = new SqliteScreenTimeStore();
    const now = Date.now();
    store.recordPing(session.userId, now);
    store.recomputeAndMaybeAlert(session.userId, session.name ?? session.email ?? null, now);
  } catch (err) {
    // Fail-open: a heartbeat is best-effort bookkeeping, never worth a
    // broken response to the client that's just trying to signal presence.
    console.warn(`[api/screen-time/heartbeat] tracking failed (ignored): ${(err as Error).message}`);
  }
  return NextResponse.json({ ok: true });
}
