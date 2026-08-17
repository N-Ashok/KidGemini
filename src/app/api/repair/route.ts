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
import { ensureAssetRuntime } from "@/lib/assets/ensure-runtime";
import { formatRepairErrorSummary } from "@/lib/game-console";
import { resolveGeo } from "@/lib/geo";
import { estimateCostUsd } from "@/lib/pricing.config";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { readGuestId } from "@/lib/chat-identity";
import { TurnLog, adoptTraceId, describeError, formatValue } from "@/lib/turn-log";
import {
  REPAIR_SYSTEM_PROMPT,
  REPAIR_TAXONOMY,
  applyPatch,
  buildRepairPrompt,
  repairFaultLine,
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
  const { html, failureCode, evidence, errors, originalRequest, traceId } = body;
  if (
    typeof html !== "string" || !html.trim() || html.length > MAX_HTML_CHARS ||
    typeof failureCode !== "string" || !(failureCode in REPAIR_TAXONOMY) ||
    typeof originalRequest !== "string" || originalRequest.length > MAX_REQUEST_CHARS ||
    !Array.isArray(errors ?? [])
  ) {
    return NextResponse.json({ error: "bad_request" } satisfies RepairResponse, { status: 400 });
  }

  const session = await safeAuth();
  const userId = session?.userId ?? readGuestId(req) ?? "guest:unknown";
  const userLabel = session?.name ?? session?.email ?? "Guest";
  const model = process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash";

  const prompt = buildRepairPrompt({
    failureCode: failureCode as RepairRequest["failureCode"],
    evidence: evidence ?? null,
    errors: (errors ?? []).slice(0, 20),
    originalRequest,
    html,
  });

  // One correlated log for this repair. `trace` continues the CHAT turn that
  // produced the game when the client sends it, so `grep trace=<id> app.log`
  // shows the build, its edits and every repair attempt in one ordered story
  // (2026-08-17 owner ask). An absent or malformed id starts a fresh trace
  // rather than failing the request — a repair must never die over telemetry.
  const log = new TurnLog("api/repair", adoptTraceId(traceId), { userId, code: failureCode });
  // Log WHAT broke, not just that something did (2026-08-15). The errors array
  // has always been received and passed to the repair prompt, but never
  // logged — so across 366 load_errors in production nobody could see the
  // actual cause, and the same generation faults kept recurring invisibly.
  // One truncated line makes them countable: `sort | uniq -c` over a week says
  // which fault to fix at the source instead of healing it forever.
  // It is a JS error string from generated code, so it carries no user text.
  //
  // BUG_LOG 2026-08-17: this line shipped as `String(errors[0])` and emitted
  // `err="[object Object]"` for every error it caught — `errors` is
  // GameConsoleMessage[], not string[] — so the instrument built to make
  // generation faults countable could not name a single one. It also read
  // errors[0], which is often the game's own startup console.log rather than
  // the failure. Both fixed in formatRepairErrorSummary, which now uses the
  // same selection rule repair-prompt.ts already used.
  const errorSummary = formatRepairErrorSummary(errors);
  log.ok("request", { htmlChars: html.length, err: errorSummary.trim() || undefined });

  let reply: string;
  let realUsage: { promptTokens: number; outputTokens: number; thoughtTokens: number; cachedTokens: number } | undefined;
  try {
    const r = await chatModel.repair({ systemPrompt: REPAIR_SYSTEM_PROMPT, prompt });
    reply = r.text;
    realUsage = r.usage;
  } catch (err) {
    log.fail("model", err);
    return NextResponse.json({ error: "repair_failed" } satisfies RepairResponse, { status: 502 });
  }

  // Recorded but gate-exempt (kind:"repair" is excluded from the tallies).
  // promptTokens/outputTokens stay estimates (gate semantics); billed* carry
  // the real usageMetadata counts and drive the cost estimate when present.
  // Wrapped (2026-07-17): Gemini already replied successfully at this point —
  // a DB write failure here must not turn an already-computed repair into a
  // 500 for the kid, purely because the usage row failed to save.
  try {
    usage.record({
      userId, userLabel, model, kind: "repair",
      userAgent: req.headers.get("user-agent"),
      promptTokens: estTokens(prompt), outputTokens: estTokens(reply),
      billedPromptTokens: realUsage?.promptTokens,
      billedOutputTokens: realUsage?.outputTokens,
      thoughtTokens: realUsage?.thoughtTokens,
      cachedTokens: realUsage?.cachedTokens,
      costUsd: estimateCostUsd(model, {
        prompt: realUsage?.promptTokens ?? estTokens(prompt),
        output: realUsage?.outputTokens ?? estTokens(reply),
        thoughts: realUsage?.thoughtTokens,
        cached: realUsage?.cachedTokens,
      }),
      geo, requestText: `repair:${failureCode}`, outputText: reply.slice(0, 4_000), blocked: false,
    });
  } catch (err) {
    log.warn("usage", { err: describeError(err) });
  }

  let patched = applyPatch(html, reply);
  if (!patched.ok) {
    // ONE bounded rescue rung (2026-08-15). Until now a repair was a single
    // shot: if the patch didn't apply, the child simply kept the broken game.
    // Production over this log: 65 such dead ends — 29 `no_patch_in_reply`
    // (the model answered in prose), 19 `search_not_found`, 9
    // `search_ambiguous`. The chat EDIT path already solved exactly this with
    // a strict retry that restates the source and demands a patch, and it
    // works there (a real edit landed via `✓ edit patch (strict retry)` the
    // same day). Reusing that call rather than inventing a second mechanism
    // is the point: one proven rung, not two drifting ones.
    //
    // Bounded on purpose: one extra model call, only on the failure path, and
    // only when we still hold the original html. A second failure means the
    // model does not understand this fault, and asking again just spends the
    // child's time.
    const firstReason = patched.reason;
    // BUG_LOG 2026-08-17: this line WAS `String(errors[0])` — "[object Object]",
    // since errors is GameConsoleMessage[] — falling back to a bare
    // `the game fails with: <code>`. This rung does 100% of the repair work in
    // production (4 of 4 observed first attempts returned no_patch_in_reply),
    // so the model actually fixing the game was told "Fix this error and change
    // nothing else: [object Object]" while REPAIR_TAXONOMY already held the
    // precise diagnosis — which element covers the button, at what coordinates,
    // and that the click handler works and must not be touched. Every observed
    // start_occluded repair came back a no-op of a dozen characters and the
    // probe re-failed on the repair's own output. Same source of truth as the
    // first attempt now, so the two cannot drift again.
    const faultLine = repairFaultLine({ failureCode, evidence: evidence ?? null, errors: errors ?? [] });
    try {
      const retry = await chatModel.strictEditRetry({
        currentHtml: html,
        message: `The game is broken. Fix this error and change nothing else: ${faultLine}`,
      });
      const retryApplied = applyPatch(html, retry.text);
      if (retryApplied.ok) {
        patched = retryApplied;
        log.ok("strict_retry", { rescued: true, first: firstReason });
      }
    } catch (err) {
      log.fail("strict_retry", err);
    }
    if (!patched.ok) {
      log.fail("apply_patch", undefined, { reason: patched.reason });
      return NextResponse.json({ error: patched.reason } satisfies RepairResponse, { status: 422 });
    }
  }

  // Floor the import map back in (BUG-FIX-LOG 2026-07-23): a repair patch can
  // rewrite/drop the injected <script type="importmap">, which would relaunch the
  // exact "Failed to resolve module specifier three" crash the repair was meant to
  // fix — a loop the model can never escape. ensureAssetRuntime is idempotent, so
  // 2D games and already-correct 3D games pass through byte-identical.
  const floored = ensureAssetRuntime(patched.html);
  log.ok("deliver", { mode: patched.mode, outChars: floored.length });
  return NextResponse.json({ patchedHtml: floored, mode: patched.mode } satisfies RepairResponse);
}

/** Same fail-safe as /api/chat: broken auth config means "guest", not a 500. */
async function safeAuth() {
  try {
    return await getAriantraSession();
  } catch (err) {
    console.warn(`[api/repair] stage=session outcome=warn err=${formatValue(describeError(err) ?? "unknown")}`);
    return null;
  }
}
