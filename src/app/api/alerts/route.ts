// GET /api/alerts — parent dashboard data, gated by the PIN-verified
// parent-session cookie (never a PIN in the URL; the "1234" default is gone).
// INTERIM until Phase 2 child scoping: the list is still global — any
// verified parent sees all alerts (kidgemini TECH_DEBT; strictly better than
// the shared-PIN era). PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 1.

import { NextRequest, NextResponse } from "next/server";
import { SqliteAlertStore } from "@/lib/db";
import { getVerifiedParentAccount } from "@/lib/parent-session.server";

export const runtime = "nodejs";

const alerts = new SqliteAlertStore();

export async function GET(_req: NextRequest) {
  const account = await getVerifiedParentAccount();
  if (!account) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ alerts: alerts.list(200) });
}
