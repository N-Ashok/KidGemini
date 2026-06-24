// POST /api/safety — standalone safety classification for the KidGemini Guard browser
// extension. Reuses the same Flash-Lite classifier and alert store as the chat app, so
// the extension and the app share one safety brain + parent dashboard.
// Body: { text: string, origin?: "child" | "model" } → SafetyVerdict (+ logs alerts).

import "@/lib/logger"; // tees server console output to logs/app.log
import { NextRequest, NextResponse } from "next/server";
import { FlashLiteClassifier } from "@/lib/safety";
import { SqliteAlertStore } from "@/lib/db";

export const runtime = "nodejs";

const classifier = new FlashLiteClassifier();
const alerts = new SqliteAlertStore();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  let body: { text?: string; origin?: "child" | "model" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }

  const text = (body.text ?? "").trim();
  const origin = body.origin === "child" ? "child" : "model";
  if (!text) {
    return NextResponse.json({ action: "allow", category: null, severity: "low", reason: "empty" }, { headers: CORS });
  }

  const verdict = await classifier.classify({ text, origin });
  console.log(`[api/safety] origin=${origin} action=${verdict.action} chars=${text.length}`);

  if (verdict.action !== "allow") {
    alerts.record({
      origin,
      category: verdict.category,
      severity: verdict.severity,
      action: verdict.action,
      triggerText: text.slice(0, 500),
      reason: verdict.reason,
    });
  }
  return NextResponse.json(verdict, { headers: CORS });
}
