// POST /api/screen-time/heartbeat — a lightweight presence ping fired by
// ScreenTimeHeartbeat.tsx while the Ari tab is open and visible, so
// playing an already-built game counts toward screen time the same as
// chatting (PRD-SCREEN-TIME-CAP-MVP Part B, extended 2026-07-15). Signed-in
// only; a guest ping is a no-op 200 — not an error, since heartbeats fire
// automatically in the background and a guest hasn't done anything wrong.
//
// Feature 4 (2026-07-28, time-exceeded parent email + child nudge): the
// response now also reports whether this call newly crossed the "nearing
// cap" or "cap exceeded" thresholds — both edge-triggered by
// recomputeAndMaybeAlert, so each fires at most once per account per day.
// On a fresh capExceeded crossing, this fires a fire-and-forget bridge call
// to the platform's mailer — never awaited, so a slow/down platform can
// never block or fail this response (fail-open contract preserved: this
// route ALWAYS returns 200 { ok: true, ... }).
//
// Redesigned 2026-08-08 (docs/BUG-FIX-LOG.md "parent-PIN OTP false
// no-email", same fix class): the bridge is now called UNCONDITIONALLY on a
// capExceeded crossing, by session.playerId — not gated on session.email,
// which a username/password login never carries. The platform resolves the
// real contact email server-side and silently no-ops if it truly has none.

import { NextResponse } from "next/server";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { SqliteScreenTimeStore } from "@/lib/db";
import { sendScreenTimeAlertEmail } from "@/lib/screen-time-alert-bridge";

export const runtime = "nodejs";

export async function POST() {
  const session = await getAriantraSession();
  if (!session) return NextResponse.json({ ok: true, nearingCap: false, capExceeded: false });

  let nearingCap = false;
  let capExceeded = false;
  try {
    const store = new SqliteScreenTimeStore();
    const now = Date.now();
    store.recordPing(session.userId, now);
    const result = store.recomputeAndMaybeAlert(session.userId, session.name ?? session.email ?? null, now);
    nearingCap = result.nearingCap;
    capExceeded = result.capExceeded;

    if (capExceeded) {
      // Fire-and-forget — NOT awaited. The heartbeat response must never
      // wait on (or fail because of) the platform's mailer. No session.email
      // gate: the platform resolves the real contact email by playerId and
      // silently no-ops if the account genuinely has none.
      void sendScreenTimeAlertEmail(
        session.playerId,
        session.name ?? session.email ?? "your child",
        result.activeMinutes,
        result.capMinutes ?? 0,
      ).catch((err) => console.warn(`[api/screen-time/heartbeat] alert email failed (ignored): ${(err as Error).message}`));
    }
  } catch (err) {
    // Fail-open: a heartbeat is best-effort bookkeeping, never worth a
    // broken response to the client that's just trying to signal presence.
    console.warn(`[api/screen-time/heartbeat] tracking failed (ignored): ${(err as Error).message}`);
    nearingCap = false;
    capExceeded = false;
  }
  return NextResponse.json({ ok: true, nearingCap, capExceeded });
}
