// GET /api/alerts — parent dashboard data. PIN-gated.

import { NextRequest, NextResponse } from "next/server";
import { SqliteAlertStore } from "@/lib/db";

export const runtime = "nodejs";

const alerts = new SqliteAlertStore();

export async function GET(req: NextRequest) {
  const pin = req.nextUrl.searchParams.get("pin");
  if (pin !== (process.env.PARENT_PIN ?? "1234")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ alerts: alerts.list(200) });
}
