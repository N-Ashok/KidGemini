"use client";
// Screen-time presence ping (PRD-SCREEN-TIME-CAP-MVP Part B, extended
// 2026-07-15): fires while the tab is open AND visible, whether the kid is
// chatting or playing a generated game in the preview — the game runs in an
// iframe within this SAME document, so visibilitychange only fires on an
// actual tab switch/minimize, never when focus moves into the iframe.
// Renders nothing. Signed-in only — guests are covered by the existing
// guest-gate elsewhere, not screen-time.

import { useEffect } from "react";
import { useSession } from "@/lib/useAriantraSession";
import { HEARTBEAT_INTERVAL_MS } from "@/lib/screen-time";

export function ScreenTimeHeartbeat() {
  const session = useSession();

  useEffect(() => {
    if (session.status !== "authenticated") return;

    const ping = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/screen-time/heartbeat", { method: "POST" }).catch(() => {});
    };

    ping(); // immediate tick so a short session (e.g. just playing, no chat) still counts
    const timer = setInterval(ping, HEARTBEAT_INTERVAL_MS);
    // A tab that comes back into view mid-interval shouldn't wait for the
    // next tick to register presence again.
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [session.status]);

  return null;
}
