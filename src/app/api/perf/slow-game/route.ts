// POST /api/perf/slow-game — a lightweight fire-and-forget ping fired by
// ArtifactFrame.tsx the moment the kid-facing "running slow" banner
// (lib/slowdown-nudge.ts) becomes visible, so a sustained slowdown shows up
// in pm2 logs (via logger.ts's existing console patch) instead of being
// visible only inside the one kid's browser tab that hit it. No auth check —
// slow rendering is a symptom worth knowing about for guest and signed-in
// sessions alike, and this carries no PII beyond ids the client already
// controls. Fail-open by design (same shape as
// /api/screen-time/heartbeat/route.ts): a malformed body, or json() itself
// throwing, must never surface as an error to the kid's session — this
// ALWAYS returns 200 { ok: true }, even when there was nothing useful to log.
//
// Throttled for free by slowdown-nudge.ts's own 45s post-fix cooldown and
// 5-consecutive-sample debounce — no separate rate limit (see
// docs/SCALABILITY_ISSUES.md #5/#7, updated alongside this).

import { NextResponse } from "next/server";

const MAX_FIELD_LEN = 100;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_FIELD_LEN) : undefined;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const docKey = body ? str(body.docKey) : undefined;
    const fpsRaw = body && typeof body.fps === "number" ? body.fps : NaN;
    const fps = Number.isFinite(fpsRaw) ? Math.floor(fpsRaw) : undefined;

    if (docKey !== undefined && fps !== undefined) {
      const heaviest =
        body && typeof body.heaviestModel === "object" && body.heaviestModel !== null
          ? (body.heaviestModel as Record<string, unknown>)
          : null;
      console.warn(
        `[perf] slow game detected: docKey=${docKey} fps=${fps}` +
          (heaviest ? ` heaviestModel=${str(heaviest.name) ?? "?"} instances=${heaviest.instances} animated=${heaviest.animated}` : " heaviestModel=none") +
          (typeof body?.drawCalls === "number" && Number.isFinite(body.drawCalls) ? ` drawCalls=${Math.floor(body.drawCalls as number)}` : "") +
          (str(body?.conversationId) ? ` conversationId=${str(body?.conversationId)}` : "") +
          (str(body?.chatId) ? ` chatId=${str(body?.chatId)}` : "") +
          (str(body?.messageId) ? ` messageId=${str(body?.messageId)}` : ""),
      );
    }
  } catch (err) {
    // Fail-open: this is best-effort diagnostic logging, never worth a
    // broken response to a kid's game session.
    console.warn(`[perf] slow-game report failed (ignored): ${(err as Error).message}`);
  }
  return NextResponse.json({ ok: true });
}
