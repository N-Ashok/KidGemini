// GET /api/usage — admin analytics data (token usage, cost, geo, per-user, raw events).
// PIN-gated. `?days=30` controls the window; `?detail=1` includes raw events.

import { NextRequest, NextResponse } from "next/server";
import { SqliteUsageStore } from "@/lib/db";

export const runtime = "nodejs";

const usage = new SqliteUsageStore();
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("pin") !== (process.env.PARENT_PIN ?? "1234")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const days = Number(params.get("days") ?? "30");
  const since = Date.now() - days * DAY_MS;

  const summary = usage.summarizeSince(since);
  const events = params.get("detail") === "1" ? usage.listSince(since) : undefined;
  return NextResponse.json({ days, summary, events });
}
