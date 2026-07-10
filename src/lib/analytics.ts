// Typed Mixpanel wrapper — the FIRST manual track() calls on kidgemini
// (everything else is autocapture; see mixpanel-snippet.ts for the privacy
// posture). Keep event/prop names here, not at call-sites, so the §11
// telemetry contract stays greppable and pinned.

import type { VerifyOutcome } from "@/types/preview-verify.types";

type AnalyticsEvent =
  | {
      name: "preview_verify";
      props: { outcome: VerifyOutcome; attempts: number; failure_code: string | null; ms: number };
    }
  | {
      name: "preview_repair";
      props: { failure_code: string; attempt: number; success: boolean; ms: number };
    };

/** Fire-and-forget; a missing/blocked Mixpanel must never break the preview. */
export function trackEvent<E extends AnalyticsEvent>(name: E["name"], props: E["props"]): void {
  if (typeof window === "undefined") return;
  const mp = (window as unknown as { mixpanel?: { track?: (n: string, p: object) => void } }).mixpanel;
  try {
    mp?.track?.(name, props);
  } catch {
    /* analytics must never throw into the UI */
  }
}
