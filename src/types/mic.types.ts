// Mic permission-recovery types (docs/PRD.md §Mic recovery; BUG-FIX-LOG
// 2026-07-20 "laptop told to fix Siri"). Interfaces first (CLAUDE.md §4 D):
// lib/platform.ts and lib/mic-recovery.ts implement against these; the
// composer/Idea Button surfaces render MicRecoveryCard without knowing how
// it was chosen.

/** OS family the recovery steps are written for. */
export type MicPlatform = "mac" | "windows" | "chromeos" | "android" | "ios" | "unknown";

/** Browser family — picks the settings-menu wording ("the 🔒 lock" vs "ᴀA"). */
export type MicBrowser = "chrome" | "edge" | "safari" | "other";

/** navigator.permissions state for "microphone", or "unknown" where the
 *  query is unsupported/throws. Unknown NEVER blocks — it falls through to
 *  the plainest instructions. */
export type MicPermissionState = "granted" | "prompt" | "denied" | "unknown";

/** Raw environment signals, injectable so detection is unit-testable. */
export interface PlatformSignals {
  /** navigator.userAgentData?.platform (Chromium only). */
  uaDataPlatform?: string;
  /** navigator.userAgentData?.mobile. */
  uaDataMobile?: boolean;
  /** navigator.userAgentData?.brands names. */
  brands?: string[];
  userAgent: string;
  /** iPadOS masquerades as macOS — touch points tell them apart. */
  maxTouchPoints?: number;
}

/** What a kid (or their grown-up) sees when the mic can't listen. */
export interface MicRecoveryCard {
  scenario:
    | "ask-coach" // pre-ask: the browser prompt is about to appear
    | "ask-again" // prompt was dismissed — just re-ask
    | "site-blocked" // door 1: this site is blocked in the browser
    | "os-blocked" // door 2: the OS is blocking the browser app
    | "no-mic" // no capture hardware
    | "network"
    | "hiccup"; // anything else — retry
  /** Emoji lead — the kid-readable "what kind of problem". */
  icon: string;
  title: string;
  /** One short line under the title ("" when the steps say it all). */
  intro: string;
  /** Numbered, device-true steps; empty for one-line scenarios. */
  steps: string[];
  /** Who can realistically fix it — "grown-up" renders the 👋 chip so a kid
   *  knows to hand off instead of failing at System Settings alone. */
  fixer: "kid" | "grown-up";
  /** Label for the primary action button (re-checks & restarts the mic). */
  primaryLabel: string;
}
