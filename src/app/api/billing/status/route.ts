// GET /api/billing/status — the signed-in user's current payment state, for the upgrade page.
// "Rails only": this reports paid/expiry but nothing enforces it yet.

import { NextResponse } from "next/server";
import { resolveUserId } from "@/lib/auth-identity";
import { SqlitePaymentStore } from "@/lib/db";

export const runtime = "nodejs";

const payments = new SqlitePaymentStore();

export async function GET() {
  const userId = await resolveUserId();
  if (!userId) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  const record = payments.latestForUser(userId);
  const paid =
    !!record && record.status === "paid" && (record.periodEndsAt ?? 0) > Date.now();
  return NextResponse.json({
    paid,
    plan: record?.planKey ?? null,
    periodEndsAt: record?.periodEndsAt ?? null,
  });
}
