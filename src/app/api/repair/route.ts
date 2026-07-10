// POST /api/repair — self-healing preview repair call (PRD §7, §12).
// The client's verify pass found a concrete failure in a game WE generated;
// this endpoint asks Gemini for a minimal patch and applies it server-side.
//
// Gate posture (§12 decision, 2026-07-10): repair is EXEMPT from the guest
// token budget — the kid didn't ask for the bug — but every call is still
// recorded (kind:"repair") for admin cost visibility, and the request is
// validated fail-closed (known failure code, bounded sizes, ≤ MAX attempts
// enforced client-side + the wall-clock bail). No published game is ever
// touched here: input and output are in-memory strings only.

import "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { GeminiChatModel } from "@/lib/gemini";
import { SqliteUsageStore } from "@/lib/db";
import { resolveGeo } from "@/lib/geo";
import { estimateCostUsd } from "@/lib/pricing.config";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { GUEST_COOKIE } from "@/lib/gate.config";
import {
  REPAIR_SYSTEM_PROMPT,
  REPAIR_TAXONOMY,
  applyPatch,
  buildRepairPrompt,
} from "@/lib/repair-prompt";
import type { RepairRequest, RepairResponse } from "@/types/preview-verify.types";

export const runtime = "nodejs";

const chatModel = new GeminiChatModel();
const usage = new SqliteUsageStore();

const MAX_HTML_CHARS = 300_000;
const MAX_REQUEST_CHARS = 2_000;
const estTokens = (t: string) => Math.ceil(t.length / 4);

export async function POST(req: NextRequest) {
  const geo = resolveGeo(req);
  let body: Partial<RepairRequest>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" } satisfies RepairResponse, { status: 400 });
  }

  // Fail-closed validation: only a known failure code with a plausible game
  // source gets a Gemini call.
  const { html, failureCode, evidence, errors, originalRequest } = body;
  if (
    typeof html !== "string" || !html.trim() || html.length > MAX_HTML_CHARS ||
    typeof failureCode !== "string" || !(failureCode in REPAIR_TAXONOMY) ||
    typeof originalRequest !== "string" || originalRequest.length > MAX_REQUEST_CHARS ||
    !Array.isArray(errors ?? [])
  ) {
    return NextResponse.json({ error: "bad_request" } satisfies RepairResponse, { status: 400 });
  }

  const session = await safeAuth();
  const userId = session?.userId ?? req.cookies.get(GUEST_COOKIE)?.value ?? "guest:unknown";
  const userLabel = session?.name ?? session?.email ?? "Guest";
  const model = process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash";

  const prompt = buildRepairPrompt({
    failureCode: failureCode as RepairRequest["failureCode"],
    evidence: evidence ?? null,
    errors: (errors ?? []).slice(0, 20),
    originalRequest,
    html,
  });

  const t0 = Date.now();
  console.log(`[api/repair] ▶ code=${failureCode} userId=${userId} htmlChars=${html.length}`);

  let reply: string;
  try {
    reply = await chatModel.repair({ systemPrompt: REPAIR_SYSTEM_PROMPT, prompt });
  } catch (err) {
    console.error(`[api/repair] ✖ gemini failed @${Date.now() - t0}ms: ${(err as Error).message}`);
    return NextResponse.json({ error: "repair_failed" } satisfies RepairResponse, { status: 502 });
  }

  // Recorded but gate-exempt (kind:"repair" is excluded from the tallies).
  usage.record({
    userId, userLabel, model, kind: "repair",
    promptTokens: estTokens(prompt), outputTokens: estTokens(reply),
    costUsd: estimateCostUsd(model, estTokens(prompt), estTokens(reply)),
    geo, requestText: `repair:${failureCode}`, outputText: reply.slice(0, 4_000), blocked: false,
  });

  const patched = applyPatch(html, reply);
  if (!patched.ok) {
    console.warn(`[api/repair] ✖ patch not applicable (${patched.reason}) @${Date.now() - t0}ms`);
    return NextResponse.json({ error: patched.reason } satisfies RepairResponse, { status: 422 });
  }

  console.log(`[api/repair] ✓ ${patched.mode} @${Date.now() - t0}ms outChars=${patched.html.length}`);
  return NextResponse.json({ patchedHtml: patched.html, mode: patched.mode } satisfies RepairResponse);
}

/** Same fail-safe as /api/chat: broken auth config means "guest", not a 500. */
async function safeAuth() {
  try {
    return await getAriantraSession();
  } catch (err) {
    console.warn(`[api/repair] session unavailable, treating as guest: ${(err as Error).message}`);
    return null;
  }
}
