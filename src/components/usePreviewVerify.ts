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
import { previewDocKey } from "@/lib/preview-pane";
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

  // Verify restarts ONLY when the game itself changes. originalRequest rides
  // along in a ref: with it in the effect deps, the kid's NEXT ask ("add a
  // score") disposed the controller and re-covered the still-unchanged old
  // game with "Testing your game…" for the whole generation (BUG-FIX-LOG
  // 2026-07-11). The ref is read when html changes, so a repair prompt still
  // carries the ask that produced THAT html.
  const requestRef = useRef(originalRequest);
  requestRef.current = originalRequest;

  // Each game html gets its own generation: `round` restarts with every
  // controller instance, so round alone COLLIDES across games (v1 can end at
  // round 1 and v2 begins at round 1) — the srcDoc memo and iframe key then
  // never change and the NEW game never reaches the preview (BUG-FIX-LOG
  // 2026-07-11: "update never shows up"). docKey = generation + round.
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
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
    controller.start(html, requestRef.current, document.hidden); // V.10 guard inside
    return () => {
      controller.dispose();
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

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

  return { state, iframeRef, onIframeLoad, docKey: previewDocKey(generationRef.current, state.round) };
}
