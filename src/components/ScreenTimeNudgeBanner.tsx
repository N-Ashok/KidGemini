"use client";
// Child-facing "nearing your screen-time cap" nudge (Feature 4, 2026-07-28).
// Mirrors RenameNoticeBanner.tsx's structure closely: self-contained,
// dismissible, role="status". Difference: this is driven by a live server
// signal (onNearingCap, via ScreenTimeHeartbeat.tsx) rather than a one-time
// mount-time check, and it resets once per UTC day instead of forever.

import { useEffect, useState } from "react";
import { onNearingCap } from "@/lib/screen-time-events";
import { utcDayStart } from "@/lib/screen-time";
import {
  SCREEN_TIME_NUDGE_LINE,
  loadScreenTimeNudge,
  saveScreenTimeNudge,
  shouldShowScreenTimeNudge,
} from "@/lib/screen-time-nudge";

export function ScreenTimeNudgeBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    return onNearingCap(() => {
      const dayStart = utcDayStart(Date.now());
      const store = loadScreenTimeNudge(window.localStorage, dayStart);
      if (shouldShowScreenTimeNudge(store)) setVisible(true);
    });
  }, []);

  function dismiss() {
    setVisible(false);
    saveScreenTimeNudge(window.localStorage, utcDayStart(Date.now()), { seen: true });
  }

  if (!visible) return null;

  return (
    <div
      role="status"
      className="mx-auto mb-2 flex w-full max-w-full items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm xl:max-w-3xl"
    >
      <span aria-hidden className="text-xl">🌙</span>
      <p className="flex-1 font-medium text-indigo-800">{SCREEN_TIME_NUDGE_LINE}</p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="rounded-full px-2 py-1 text-indigo-700 hover:bg-indigo-100"
      >
        ✕
      </button>
    </div>
  );
}
