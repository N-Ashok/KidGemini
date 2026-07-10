"use client";
// Self-healing preview — React ADAPTER only. The verify/repair state machine
// lives in lib/preview-verify-controller.ts (framework-free, unit-tested):
// the first effect-based version cancelled its own repair continuation on the
// phase transition and left the cover stuck on "Fixing…" forever (BUG-FIX-LOG
// 2026-07-10). This hook only wires browser events in and state out.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PreviewVerifyController,
  type VerifyControllerState,
} from "@/lib/preview-verify-controller";
import { PARENT_READY_SOURCE } from "@/lib/preview-verify";
import { repairEnabled } from "@/lib/verify-policy";
import { trackEvent } from "@/lib/analytics";
import type { RepairResponse } from "@/types/preview-verify.types";

/** A hung /api/repair must not hold the cover past the §8.4 bail window. */
const REPAIR_FETCH_TIMEOUT_MS = 15_000;

function initialState(html: string): VerifyControllerState {
  return {
    phase: "testing",
    currentHtml: html,
    round: 0,
    probesEnabled: true,
    checks: [],
    kidLine: null,
    question: null,
    outcome: null,
  };
}

export function usePreviewVerify(html: string, originalRequest: string) {
  const [state, setState] = useState<VerifyControllerState>(() => initialState(html));
  const controllerRef = useRef<PreviewVerifyController | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const controller = new PreviewVerifyController({
      fetchRepair: async (req) => {
        const res = await fetch("/api/repair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(REPAIR_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`repair ${res.status}`);
        return (await res.json()) as RepairResponse;
      },
      track: (name, props) =>
        trackEvent(name, props as Parameters<typeof trackEvent>[1]),
      now: () => performance.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (t) => window.clearTimeout(t as number),
      repairEnabled: repairEnabled(),
      onChange: setState,
    });
    controllerRef.current = controller;
    const onMessage = (event: MessageEvent) => controller.handleMessage(event.data);
    const onVisibility = () => {
      if (document.hidden) controller.markInterrupted(); // V.11
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    controller.start(html, originalRequest, document.hidden); // V.10 guard inside
    return () => {
      controller.dispose();
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [html, originalRequest]);

  /** Ready handshake (§0 A2 race): the injected scripts buffer everything
   *  until this lands. `verify:false` on post-verify reloads keeps the probe
   *  script inert — nothing ghost-clicks the kid's Start button. */
  const onIframeLoad = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        source: PARENT_READY_SOURCE,
        type: "ready",
        verify: controllerRef.current?.getState().probesEnabled ?? false,
      },
      "*",
    );
  }, []);

  return { state, iframeRef, onIframeLoad };
}
