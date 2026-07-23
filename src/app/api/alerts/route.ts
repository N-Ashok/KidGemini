// GET /api/alerts — parent dashboard data, gated by the PIN-verified
// parent-session cookie (never a PIN in the URL; the "1234" default is gone).
// PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2 (2026-07-23): the list is now scoped
// to the verified parent's OWN account — a parent never sees another family's
// alerts. Legacy un-owned alerts (accountId NULL) surface to no one (fail closed).

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
  return NextResponse.json({ alerts: alerts.list(account, 200) });
}
