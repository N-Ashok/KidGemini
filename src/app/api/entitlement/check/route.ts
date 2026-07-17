export const dynamic = "force-dynamic";
/**
 * [api/entitlement/check] POST — Phase 5 entitlement bridge
 * (../Ariantra-Platform/docs/PRD-MULTIPLAYER.md Open Decision #1, resolved
 * 2026-07-14: platform-side check). The REVERSE direction of every other
 * cross-repo call in this codebase — the Ariantra platform calls INTO
 * Ari, since Ari holds the Razorpay payment truth (`payments`
 * table). Auth mirrors `/api/arcade/publish`'s gate, inverted:
 *   `x-admin-secret` header must equal the shared AUTH_JWT_SECRET.
 * The caller forwards the raw `ariantra_session` JWT it already holds (the
 * SAME token Ari's OWN browser calls carry) rather than a derived id —
 * `verifyAriantraSession` derives the identical `userId` string
 * (`user:<email|name|sub>`) that `payments.userId` rows already use, so there
 * is no separate identity-mapping table to get wrong or drift.
 *
 * Body: { sessionToken } → { entitled, planKey, periodEndsAt }
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAriantraSession } from "@/lib/ariantra-session";
import { SqlitePaymentStore } from "@/lib/db";
import { isEntitled } from "@/lib/entitlement";

const payments = new SqlitePaymentStore();

interface Body {
  sessionToken?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  if (!secret || req.headers.get("x-admin-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const session = await verifyAriantraSession(body.sessionToken ?? "", secret);
  if (!session) {
    return NextResponse.json({ error: "invalid_session" }, { status: 401 });
  }

  const record = payments.latestForUser(session.userId);
  return NextResponse.json({
    entitled: isEntitled(record),
    planKey: record?.planKey ?? null,
    periodEndsAt: record?.periodEndsAt ?? null,
  });
}
