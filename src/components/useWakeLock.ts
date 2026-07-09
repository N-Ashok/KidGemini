"use client";
// Keeps the phone screen awake while `active` (a reply is streaming). Screen
// auto-lock killing the socket mid-generation is the top cause of dropped
// streams on phones (BUG-FIX-LOG 2026-07-07 / 2026-07-09). Single
// responsibility: hold a screen wake lock; no chat logic. No-op where the
// Wake Lock API is unavailable (old browsers, insecure context).

import { useEffect } from "react";

type WakeLockSentinel = { release: () => Promise<void> };
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
};

export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const s = await nav.wakeLock!.request("screen");
        if (cancelled) await s.release();
        else sentinel = s;
      } catch {
        // Denied (e.g. low battery mode) — the retry layer still covers us.
      }
    };
    void acquire();

    // The lock auto-releases when the tab is hidden (app switch) — re-acquire
    // as soon as the kid comes back while the reply is still streaming.
    const onVisibility = () => {
      if (!document.hidden) void acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      sentinel?.release().catch(() => {});
    };
  }, [active]);
}
