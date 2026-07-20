// Platform/browser detection + mic-permission query for the recovery cards
// (BUG-FIX-LOG 2026-07-20 "laptop told to fix Siri"). Detection is pure —
// signals injected — so every device row unit-tests plain; the two thin
// browser readers at the bottom are the only navigator touchpoints.

import type {
  MicBrowser,
  MicPermissionState,
  MicPlatform,
  PlatformSignals,
} from "@/types/mic.types";

export function detectPlatform(s: PlatformSignals): MicPlatform {
  // iPadOS reports as a Mac (uaData "macOS" / UA "Macintosh") but is the only
  // "Mac" with real touch — its settings are iOS settings, so check first.
  const touch = (s.maxTouchPoints ?? 0) > 1;
  const p = s.uaDataPlatform ?? "";
  if (p) {
    if (/^mac/i.test(p)) return touch ? "ios" : "mac";
    if (/^win/i.test(p)) return "windows";
    if (/chrome ?os/i.test(p)) return "chromeos";
    if (/^android/i.test(p)) return "android";
    if (/^ios/i.test(p)) return "ios";
  }
  const ua = s.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Macintosh|Mac OS X/.test(ua)) return touch ? "ios" : "mac";
  if (/Windows/.test(ua)) return "windows";
  return "unknown";
}

export function detectBrowser(s: PlatformSignals): MicBrowser {
  const brands = s.brands ?? [];
  // Edge ships the Chrome brand too — check Edge before Chrome, everywhere.
  if (brands.some((b) => /edge/i.test(b))) return "edge";
  if (brands.some((b) => /chrome/i.test(b))) return "chrome";
  const ua = s.userAgent;
  if (/Edg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

/** Human name for the steps ("Switch on Chrome…"). */
export function browserDisplayName(b: MicBrowser): string {
  return b === "chrome" ? "Chrome" : b === "edge" ? "Edge" : b === "safari" ? "Safari" : "your browser";
}

// ── browser-edge readers (guarded; return safe defaults on the server) ──────

type UAData = { platform?: string; mobile?: boolean; brands?: Array<{ brand: string }> };

export function readPlatformSignals(): PlatformSignals {
  if (typeof navigator === "undefined") return { userAgent: "" };
  const uaData = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
  return {
    uaDataPlatform: uaData?.platform,
    uaDataMobile: uaData?.mobile,
    brands: uaData?.brands?.map((b) => b.brand),
    userAgent: navigator.userAgent ?? "",
    maxTouchPoints: navigator.maxTouchPoints,
  };
}

/** "denied" vs "prompt" picks recovery steps vs a simple re-ask; anything
 *  that fails (Firefox name support, older Safari) is "unknown" and falls
 *  through to the plainest instructions — the query never blocks the mic. */
export async function queryMicPermission(): Promise<MicPermissionState> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted" || status.state === "prompt" || status.state === "denied"
      ? status.state
      : "unknown";
  } catch {
    return "unknown";
  }
}
