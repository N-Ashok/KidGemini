// Server-visible slow-game reporting (2026-08-04, follow-up to
// docs/2026-07-30_PRD_PreviewPerfPanel.md's kid-facing banner). Neither the
// banner (slowdown-nudge.ts) nor the debug Perf tab (assets/perf-probe.ts)
// told anyone outside the kid's own browser tab that a game was slow — this
// turns a detected sustained slowdown into one small POST to
// /api/perf/slow-game, which logs it via console.warn (logger.ts's existing
// console patch → logs/app.log + pm2 stdout, same house pattern as every
// other route). Throttled for free by slowdown-nudge.ts's own 45s
// post-fix cooldown — no separate rate limit needed (see
// docs/SCALABILITY_ISSUES.md #5/#7).
//
// buildSlowGameReport is pure/tested; reportSlowGame is a thin,
// fire-and-forget fetch wrapper ArtifactFrame.tsx calls when the banner's
// visibility flips true — never awaited, never allowed to affect the kid's
// session either way.

import type { PerfModelEntry } from "@/types/preview-perf.types";
import { heaviestModel } from "./slowdown-nudge";

/** Implausible beyond this for any real id/key this app generates — a
 *  fail-safe truncation, not a real-world limit (see perf-report.test.ts). */
const MAX_FIELD_LEN = 100;

function truncate(s: string): string {
  return s.length > MAX_FIELD_LEN ? s.slice(0, MAX_FIELD_LEN) : s;
}

export interface SlowGameReport {
  docKey: string;
  fps: number;
  heaviestModel: { name: string; instances: number; animated: boolean } | null;
  conversationId?: string;
  chatId?: string;
  messageId?: string;
}

export function buildSlowGameReport(input: {
  docKey: string;
  fps: number;
  models: PerfModelEntry[];
  conversationId?: string;
  chatId?: string;
  messageId?: string;
}): SlowGameReport {
  const heaviest = heaviestModel(input.models);
  return {
    docKey: truncate(input.docKey),
    fps: Math.floor(input.fps),
    heaviestModel: heaviest ? { name: heaviest.name, instances: heaviest.instances, animated: heaviest.animated } : null,
    ...(input.conversationId !== undefined ? { conversationId: truncate(input.conversationId) } : {}),
    ...(input.chatId !== undefined ? { chatId: truncate(input.chatId) } : {}),
    ...(input.messageId !== undefined ? { messageId: truncate(input.messageId) } : {}),
  };
}

/** Fire-and-forget — never awaited by the caller, never throws into it
 *  either. A failed report is lost telemetry, not a broken kid session. */
export function reportSlowGame(report: SlowGameReport): void {
  void fetch("/api/perf/slow-game", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  }).catch(() => {
    /* best-effort; nothing to do client-side if this fails */
  });
}
