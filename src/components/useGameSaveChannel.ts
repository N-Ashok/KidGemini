"use client";
// Save & continue building — React ADAPTER only
// (docs/2026-08-01_PRD_SaveContinueBuilding.md §3b/§3c/§3f). The
// request/response correlation lives in lib/game-save-channel.ts
// (framework-free, unit-tested) — same division of responsibility as
// usePreviewVerify.ts / PreviewVerifyController. This hook only wires the
// iframe postMessage channel, the existing-save lookup, and the autosave
// interval; it owns no business logic of its own.

import { useEffect, useRef, useState, type RefObject } from "react";
import { GameSaveChannel } from "@/lib/game-save-channel";
import { gameSupportsSave } from "@/lib/game-save-active";
import { AUTOSAVE_INTERVAL_MS } from "@/lib/game-save.config";
import type { GameSaveState } from "@/types/game-save.types";

export type SaveDecisionPhase = "checking" | "pending" | "resolved";

interface UseGameSaveChannelOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  html: string;
  conversationId?: string;
  messageId?: string;
  /** Gate autosave/lookup to when the game is actually up and playable —
   *  never mid-verify-cover or while an update streams in over it. */
  active: boolean;
}

interface UseGameSaveChannelResult {
  /** True only when every precondition is met: a save-capable game, both
   *  ids present, and the caller says it's safe to touch the game right now. */
  isActive: boolean;
  decisionPhase: SaveDecisionPhase;
  existingSave: GameSaveState | null;
  /** Set only once the kid picks "Continue" — fold into the srcDoc so
   *  __ARIANTRA_INITIAL_STATE__ lands before the game's own script runs. */
  injectedState: GameSaveState | null;
  continueBuild: () => void;
  startFresh: () => void;
}

export function useGameSaveChannel({
  iframeRef,
  html,
  conversationId,
  messageId,
  active,
}: UseGameSaveChannelOptions): UseGameSaveChannelResult {
  const isActive = active && gameSupportsSave(html) && Boolean(conversationId) && Boolean(messageId);

  const [decisionPhase, setDecisionPhase] = useState<SaveDecisionPhase>("checking");
  const [existingSave, setExistingSave] = useState<GameSaveState | null>(null);
  const [injectedState, setInjectedState] = useState<GameSaveState | null>(null);

  // A new message id (a fresh build, or "Continue from here" pinning a
  // different one) starts a fresh decision — regenerating never inherits an
  // older message's save (PRD §3d), and neither does its UI state.
  useEffect(() => {
    setDecisionPhase("checking");
    setExistingSave(null);
    setInjectedState(null);
  }, [messageId]);

  // Look up an existing save exactly once per messageId, only when active.
  useEffect(() => {
    if (!isActive || decisionPhase !== "checking" || !messageId) return;
    let cancelled = false;
    fetch(`/api/game-save?messageId=${encodeURIComponent(messageId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ state?: GameSaveState }>) : null))
      .then((body) => {
        if (cancelled) return;
        if (body?.state) {
          setExistingSave(body.state);
          setDecisionPhase("pending");
        } else {
          setDecisionPhase("resolved"); // nothing to continue — game boots fresh, autosave may start
        }
      })
      .catch(() => {
        if (!cancelled) setDecisionPhase("resolved"); // fail safe: no banner shown, never stuck "checking"
      });
    return () => {
      cancelled = true;
    };
  }, [isActive, decisionPhase, messageId]);

  // The postMessage channel + autosave interval — only once the kid's
  // decision (if any) is resolved, so autosave can never overwrite a save
  // the kid hasn't been asked about yet.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const messageIdRef = useRef(messageId);
  messageIdRef.current = messageId;

  useEffect(() => {
    if (!isActive || decisionPhase !== "resolved") return;
    const channel = new GameSaveChannel({
      postMessage: (msg) => iframeRef.current?.contentWindow?.postMessage(msg, "*"),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (t) => window.clearTimeout(t as number),
    });
    const onMessage = (event: MessageEvent) => channel.handleMessage(event.data);
    window.addEventListener("message", onMessage);

    async function tick() {
      if (document.hidden) return; // §3c: only while the tab is visible
      const result = await channel.requestSave();
      if (!result.ok) return;
      // Best-effort: PRD carries no error UI for a dropped autosave — the
      // server debounce (§3c) already guards the write path, and the next
      // tick tries again.
      await fetch("/api/game-save", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          messageId: messageIdRef.current,
          state: result.state,
        }),
      }).catch(() => {});
    }
    const interval = window.setInterval(() => void tick(), AUTOSAVE_INTERVAL_MS);
    return () => {
      channel.dispose();
      window.removeEventListener("message", onMessage);
      window.clearInterval(interval);
    };
  }, [isActive, decisionPhase, iframeRef]);

  return {
    isActive,
    decisionPhase,
    existingSave,
    injectedState,
    continueBuild: () => {
      setInjectedState(existingSave);
      setDecisionPhase("resolved");
    },
    startFresh: () => setDecisionPhase("resolved"),
  };
}
