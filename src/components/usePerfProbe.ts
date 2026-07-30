"use client";
// Preview Perf Panel — React ADAPTER only (docs/2026-07-30_PRD_PreviewPerfPanel.md
// §3, step 6). Same shape as usePreviewVerify.ts minus the repair state
// machine: this hook has no phases to drive, it just listens for
// PERF_PROBE_SOURCE messages and holds the latest snapshot. Debug-only —
// ArtifactFrame only renders anything with this data behind the same
// `kidgemini:debug` gate as the console tab; the hook itself is harmless to
// mount unconditionally (it does nothing until a message arrives).

import { useEffect, useState } from "react";
import { PERF_PROBE_SOURCE } from "@/lib/preview-messages";
import type { PerfSnapshot } from "@/types/preview-perf.types";

/** `resetKey` should be the same docKey ArtifactFrame keys its iframe with —
 *  passing a new one (new game / new verify round) clears the last snapshot
 *  so a stale reading from the PREVIOUS game never lingers under the new
 *  one (same reasoning as ArtifactFrame's own consoleMessages reset on
 *  `[html]`). */
export function usePerfProbe(resetKey?: string) {
  const [snapshot, setSnapshot] = useState<PerfSnapshot | null>(null);

  useEffect(() => {
    setSnapshot(null);
    function onMessage(event: MessageEvent) {
      if (event.data?.source !== PERF_PROBE_SOURCE) return;
      const e = event.data.event as { type: "snapshot"; snapshot: PerfSnapshot } | undefined;
      if (e?.type === "snapshot") setSnapshot(e.snapshot);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [resetKey]);

  return { snapshot };
}
