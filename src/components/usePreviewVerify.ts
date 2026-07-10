"use client";
// Self-healing preview — client orchestration (PRD §4, §8). One verify ROUND
// per rendered iframe: collect structured errors + probe evidence, classify,
// then either uncover (clean/inconclusive) or ask /api/repair for a minimal
// patch and re-verify the patched HTML. Caps and the 20s bail live in
// verify-policy.ts (pure, tested); this hook is only the wiring.

import { useCallback, useEffect, useRef, useState } from "react";
import { GAME_CONSOLE_SOURCE } from "@/lib/game-console";
import {
  CLICK_WAIT_MS,
  PARENT_READY_SOURCE,
  PIXEL_WINDOW_MS,
  PREVIEW_VERIFY_SOURCE,
  SETTLE_MS,
  classifyVerify,
} from "@/lib/preview-verify";
import {
  WALL_CLOCK_CAP_MS,
  repairEnabled,
  shouldRepair,
  shouldStartVerify,
  verifyOutcome,
} from "@/lib/verify-policy";
import { REPAIR_TAXONOMY, SECOND_ATTEMPT_LINE, exhaustedQuestion } from "@/lib/repair-prompt";
import { trackEvent } from "@/lib/analytics";
import type { GameConsoleMessage } from "@/types/game-console.types";
import type {
  RepairResponse,
  VerifyCheckId,
  VerifyEvidence,
  VerifyScriptEvent,
} from "@/types/preview-verify.types";

/** If the probe script never reports (game clobbered postMessage, document
 *  crashed, iframe unmounted), give up waiting and pass through — a stuck
 *  cover screen is the §8.4 failure mode to fear. */
const ROUND_HARD_TIMEOUT_MS = SETTLE_MS + PIXEL_WINDOW_MS + CLICK_WAIT_MS + 6_000;

export type VerifyPhase = "testing" | "repairing" | "done";

export interface PreviewVerifyView {
  phase: VerifyPhase;
  /** The HTML actually rendered — the repaired version once a patch lands. */
  currentHtml: string;
  /** Progressive probe results for the §8.3 honest checklist. */
  checks: Array<{ check: VerifyCheckId; ok: boolean }>;
  /** §8.3 State-3 line while a repair is in flight. */
  kidLine: string | null;
  /** §9.1 question when repair is exhausted/bailed — never a stack trace. */
  question: string | null;
}

interface RunState {
  t0: number;
  attempt: number;
  interrupted: boolean;
  versions: Array<{ html: string; severity: number }>;
}

export function usePreviewVerify(html: string, originalRequest: string) {
  const [phase, setPhase] = useState<VerifyPhase>("testing");
  const [currentHtml, setCurrentHtml] = useState(html);
  const [checks, setChecks] = useState<PreviewVerifyView["checks"]>([]);
  const [kidLine, setKidLine] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  // Bumped when verify finished clean BUT the probe had to click Start to
  // prove it — the game is now running headless behind the cover, so the
  // iframe reloads once to give the kid their pristine title screen back.
  const [reloadToken, setReloadToken] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const runRef = useRef<RunState>({ t0: 0, attempt: 0, interrupted: false, versions: [] });

  // New generation (or reopened artifact) → fresh run. §8.1/V.10 guard:
  // rAF doesn't tick in hidden tabs, so verifying there would "repair"
  // healthy games — skip entirely and pass through.
  useEffect(() => {
    runRef.current = { t0: performance.now(), attempt: 0, interrupted: false, versions: [] };
    setCurrentHtml(html);
    setChecks([]);
    setKidLine(null);
    setQuestion(null);
    if (!shouldStartVerify(document.hidden)) {
      setPhase("done");
      trackEvent("preview_verify", { outcome: "skipped", attempts: 0, failure_code: null, ms: 0 });
    } else {
      setPhase("testing");
    }
  }, [html]);

  // One verify round per rendered currentHtml.
  useEffect(() => {
    if (phase !== "testing") return;
    const run = runRef.current;
    const roundHtml = currentHtml;
    const errors: GameConsoleMessage[] = [];
    let evidence: VerifyEvidence | null = null;
    let settled = false;
    let cancelled = false;

    const onVisibility = () => {
      if (document.hidden) run.interrupted = true; // V.11 → inconclusive, no repair
    };
    const onMessage = (event: MessageEvent) => {
      const d = event.data as
        | { source?: string; message?: GameConsoleMessage; event?: VerifyScriptEvent }
        | undefined;
      if (!d?.source) return;
      if (d.source === GAME_CONSOLE_SOURCE && d.message?.level === "error") {
        errors.push(d.message);
      } else if (d.source === PREVIEW_VERIFY_SOURCE && d.event) {
        const ev = d.event;
        if (ev.type === "check") {
          setChecks((prev) => [...prev.filter((c) => c.check !== ev.check), { check: ev.check, ok: ev.ok }]);
        } else if (ev.type === "result") {
          evidence = ev.evidence;
          void settle();
        }
      }
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    const hardTimer = setTimeout(() => void settle(), ROUND_HARD_TIMEOUT_MS);

    function finish(finalCode: string, bailed: boolean, probeClicked = false) {
      const outcome = verifyOutcome({ finalCode, attempts: run.attempt, bailed });
      const clean = finalCode === "clean" || finalCode === "inconclusive";
      trackEvent("preview_verify", {
        outcome,
        attempts: run.attempt,
        failure_code: clean ? null : finalCode,
        ms: Math.round(performance.now() - run.t0),
      });
      if (outcome === "failed" || outcome === "bailed") {
        // §8.4 — uncover the BEST version we have (least-broken, latest wins
        // ties) and turn the dead end into a question the kid can answer.
        const best = [...run.versions].sort((a, b) => a.severity - b.severity)[0];
        if (best && best.html !== roundHtml) setCurrentHtml(best.html);
        setQuestion(exhaustedQuestion());
      }
      if ((outcome === "clean" || outcome === "repaired") && probeClicked) {
        setReloadToken((t) => t + 1);
      }
      setKidLine(null);
      setPhase("done");
    }

    async function settle() {
      if (settled || cancelled) return;
      settled = true;
      clearTimeout(hardTimer);
      const c = classifyVerify({ errors, evidence, interrupted: run.interrupted });
      const isClean = c.code === "clean" || c.code === "inconclusive";
      run.versions.push({ html: roundHtml, severity: isClean ? 0 : errors.length > 0 ? 2 : 1 });
      if (isClean) {
        // The probe clicks whenever it found a start control (§6.2).
        finish(c.code, false, Boolean(evidence?.start?.found));
        return;
      }
      const elapsedMs = performance.now() - run.t0;
      if (!shouldRepair({ attempt: run.attempt, elapsedMs, enabled: repairEnabled() })) {
        finish(c.code, elapsedMs >= WALL_CLOCK_CAP_MS);
        return;
      }

      // §8.3 State 3 — say it plainly, truthfully, from the failure code.
      setPhase("repairing");
      setKidLine(run.attempt === 0 ? `Oops — ${REPAIR_TAXONOMY[c.code].kidLine}` : SECOND_ATTEMPT_LINE);
      run.attempt++;
      const tRepair = performance.now();
      try {
        const res = await fetch("/api/repair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            html: roundHtml,
            failureCode: c.code,
            evidence: "evidence" in c ? c.evidence : null,
            errors: errors.slice(0, 20),
            originalRequest,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as RepairResponse;
        const success = Boolean(res.ok && data.patchedHtml);
        trackEvent("preview_repair", {
          failure_code: c.code,
          attempt: run.attempt,
          success,
          ms: Math.round(performance.now() - tRepair),
        });
        if (cancelled) return;
        if (!success) {
          finish(c.code, false);
          return;
        }
        // Patched — a fresh round verifies it (state batch → one re-render).
        setChecks([]);
        setPhase("testing");
        setCurrentHtml(data.patchedHtml!);
      } catch {
        if (!cancelled) finish(c.code, false);
      }
    }

    return () => {
      cancelled = true;
      clearTimeout(hardTimer);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [phase, currentHtml, originalRequest]);

  /** Ready handshake (§0 A2 race): the injected scripts buffer everything
   *  until this lands, so nothing fired in the game's first ticks is lost. */
  const onIframeLoad = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ source: PARENT_READY_SOURCE, type: "ready" }, "*");
  }, []);

  const view: PreviewVerifyView = { phase, currentHtml, checks, kidLine, question };
  return { view, iframeRef, onIframeLoad, reloadToken };
}
