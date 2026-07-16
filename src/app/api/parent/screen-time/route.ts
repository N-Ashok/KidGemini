// GET/POST /api/parent/screen-time — the daily-minutes cap a parent sets for
// their kid, gated by the same PIN-verified parent-session cookie as
// /api/alerts (no freshness requirement: a number isn't a credential, unlike
// PIN set/reset). PRD-SCREEN-TIME-CAP-MVP Part B.

import { NextRequest, NextResponse } from "next/server";
import { SqliteScreenTimeStore } from "@/lib/db";
import { getVerifiedParentAccount } from "@/lib/parent-session.server";
import { utcDayStart } from "@/lib/screen-time";

export const runtime = "nodejs";

const store = new SqliteScreenTimeStore();

function todayTally(accountId: string): { dayStart: number; todayActiveMinutes: number } {
  const dayStart = utcDayStart(Date.now());
  const row = store.getToday(accountId, dayStart);
  return { dayStart, todayActiveMinutes: row?.activeMinutes ?? 0 };
}

export async function GET(_req: NextRequest) {
  const account = await getVerifiedParentAccount();
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const settings = store.getSettings(account);
  const { dayStart, todayActiveMinutes } = todayTally(account);
  return NextResponse.json({
    dailyCapMinutes: settings?.dailyCapMinutes ?? null,
    todayActiveMinutes,
    dayStart,
  });
}

export async function POST(req: NextRequest) {
  const account = await getVerifiedParentAccount();
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { dailyCapMinutes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const raw = body.dailyCapMinutes;
  if (raw === undefined) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  let dailyCapMinutes: number | null;
  if (raw === null) {
    dailyCapMinutes = null;
  } else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 1440) {
    dailyCapMinutes = raw;
  } else {
    return NextResponse.json(
      { error: "invalid_cap", message: "Pick a cap between 1 and 1440 minutes, or clear it." },
      { status: 422 },
    );
  }

  store.putSettings(account, dailyCapMinutes);
  const { dayStart, todayActiveMinutes } = todayTally(account);
  return NextResponse.json({ ok: true, dailyCapMinutes, todayActiveMinutes, dayStart });
}
