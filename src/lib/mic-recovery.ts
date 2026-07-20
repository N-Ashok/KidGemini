// Device-aware mic recovery cards (docs/PRD.md §Mic recovery; BUG-FIX-LOG
// 2026-07-20 "laptop told to fix Siri"). Pure: (error code × platform ×
// browser × permission state) → the card a kid or their grown-up can follow.
//
// The mic goes through TWO doors — the site's permission in the browser
// (error "not-allowed") and the OS's permission for the browser app itself
// (typically "service-not-allowed") — and each door is fixed in a different
// place per device. The old micErrorMessage() collapsed all of that into one
// string per code, which is how a laptop got told to enable Siri.

import type { MicBrowser, MicPermissionState, MicPlatform, MicRecoveryCard } from "@/types/mic.types";
import { browserDisplayName } from "./platform";

export interface MicRecoveryInput {
  /** SpeechRecognitionErrorEvent.error code. */
  code: string;
  platform: MicPlatform;
  browser: MicBrowser;
  permission: MicPermissionState;
}

const TRY_AGAIN = "Try again";

/** Wireframe A — shown BEFORE the browser's own permission prompt, so the
 *  prompt is expected instead of alarming (kids dismiss surprises). */
export function micAskCoachCard(platform: MicPlatform): MicRecoveryCard {
  const where =
    platform === "android" || platform === "ios" ? "on the screen" : "near the top of the window ↑";
  return {
    scenario: "ask-coach",
    icon: "🎙️",
    title: "Your browser will ask about the microphone",
    intro: `Choose Allow — look ${where} — so I can hear your game ideas!`,
    steps: [],
    fixer: "kid",
    primaryLabel: "Okay, ask me!",
  };
}

export function micRecoveryCard(input: MicRecoveryInput): MicRecoveryCard {
  const { code, platform, browser, permission } = input;
  switch (code) {
    case "not-allowed":
      // S1 — the kid just dismissed the ask; nothing is saved yet. Re-ask.
      if (permission === "prompt") {
        return {
          scenario: "ask-again",
          icon: "🎤",
          title: "Let's try that again",
          intro: "Tap the mic and choose Allow when the browser asks.",
          steps: [],
          fixer: "kid",
          primaryLabel: TRY_AGAIN,
        };
      }
      return siteBlockedCard(platform, browser);
    case "service-not-allowed":
      return osBlockedCard(platform, browser);
    case "audio-capture":
      return {
        scenario: "no-mic",
        icon: "🎧",
        title: "I can't find a microphone",
        intro:
          platform === "android" || platform === "ios"
            ? "Check another app isn't using the mic — or just type your idea, I read fast!"
            : "Plug in headphones with a mic — or just type your idea, I read fast!",
        steps: [],
        fixer: "kid",
        primaryLabel: TRY_AGAIN,
      };
    case "network":
      return {
        scenario: "network",
        icon: "📶",
        title: "Talking needs the internet",
        intro: "Check the Wi-Fi and try again.",
        steps: [],
        fixer: "kid",
        primaryLabel: TRY_AGAIN,
      };
    default:
      return {
        scenario: "hiccup",
        icon: "🎤",
        title: "The mic hiccuped",
        intro: "Press Try again — or type your idea!",
        steps: [],
        fixer: "kid",
        primaryLabel: TRY_AGAIN,
      };
  }
}

/** Door 1 — this site is blocked in the browser. Steps name the exact icon
 *  for the detected browser; mostly kid-reachable. */
function siteBlockedCard(platform: MicPlatform, browser: MicBrowser): MicRecoveryCard {
  const base = {
    scenario: "site-blocked" as const,
    icon: "🎤",
    title: "The mic is switched off for Ari",
    intro: "",
    primaryLabel: TRY_AGAIN,
  };
  if (platform === "ios") {
    return {
      ...base,
      fixer: "grown-up",
      steps:
        browser === "safari"
          ? [
              "Tap the ᴀA button next to the web address",
              "Tap Website Settings → Microphone",
              "Choose Allow, then press Try again!",
            ]
          : [
              "Open the Settings app",
              `Find ${browserDisplayName(browser)} and tap Microphone`,
              "Choose Allow, then press Try again!",
            ],
    };
  }
  if (platform === "android") {
    return {
      ...base,
      fixer: "kid",
      steps: [
        "Tap the 🔒 next to the web address",
        "Tap Permissions → Microphone",
        "Choose Allow, then press Try again!",
      ],
    };
  }
  if (browser === "safari") {
    return {
      ...base,
      fixer: "kid",
      steps: [
        "Click Safari in the menu at the top of the screen",
        "Choose Settings for This Website → Microphone → Allow",
        "Come back and press Try again!",
      ],
    };
  }
  // Desktop Chrome/Edge/other — the lock (or tune ⚙) icon by the address.
  return {
    ...base,
    fixer: "kid",
    steps: [
      "Click the 🔒 lock next to the web address",
      "Find Microphone and switch it to Allow",
      "Come back and press Try again!",
    ],
  };
}

/** Door 2 — the OS is blocking the browser app itself. The browser can't fix
 *  this, and neither can most kids: always grown-up flagged. */
function osBlockedCard(platform: MicPlatform, browser: MicBrowser): MicRecoveryCard {
  const name = browserDisplayName(browser);
  const base = {
    scenario: "os-blocked" as const,
    fixer: "grown-up" as const,
    intro: "This one's fixed in the device's own settings — ask a grown-up to:",
    primaryLabel: TRY_AGAIN,
  };
  switch (platform) {
    case "mac":
      return {
        ...base,
        icon: "💻",
        title: "Your computer is blocking the browser's microphone",
        steps: [
          "Open  System Settings",
          "Click Privacy & Security → Microphone",
          `Switch on ${name}, then reopen it`,
        ],
      };
    case "windows":
      return {
        ...base,
        icon: "💻",
        title: "Your computer is blocking the browser's microphone",
        steps: [
          "Open Settings → Privacy & security → Microphone",
          "Turn on Microphone access",
          "Turn on Let desktop apps access your microphone",
        ],
      };
    case "chromeos":
      return {
        ...base,
        icon: "💻",
        title: "This Chromebook is blocking the microphone",
        steps: [
          "Open Settings → Privacy and security",
          "Turn the microphone toggle on",
          "Then press Try again!",
        ],
      };
    case "ios":
      return {
        ...base,
        icon: "📱",
        title: "Dictation is switched off on this device",
        steps: [
          "Open the Settings app",
          "Tap Siri & Dictation (or General → Keyboard)",
          "Turn on Dictation, then press Try again!",
        ],
      };
    case "android":
      return {
        ...base,
        icon: "📱",
        title: `This device is blocking ${name}'s microphone`,
        steps: [
          `Open Settings → Apps → ${name}`,
          "Tap Permissions → Microphone",
          "Choose Allow, then press Try again!",
        ],
      };
    default:
      return {
        ...base,
        icon: "🎤",
        title: "This device is blocking the browser's microphone",
        steps: [
          "Open the device's settings",
          "Find the microphone privacy permissions",
          `Allow ${name} to use the microphone`,
        ],
      };
  }
}
