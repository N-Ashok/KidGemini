// Device-aware mic recovery cards — the S1–S10 scenario matrix (docs/PRD.md
// §Mic recovery). REGRESSION (BUG-FIX-LOG 2026-07-20 "laptop told to fix
// Siri"): micErrorMessage("service-not-allowed") hardcoded "Your phone's
// dictation… Siri & Dictation" for every device; a laptop family followed
// steps that don't exist on a laptop and gave up. Cards are now chosen from
// (error code × platform × browser × permission state) and every card ends
// in an action, never a dead end.
import { describe, it, expect } from "vitest";
import { micAskCoachCard, micRecoveryCard } from "./mic-recovery";
import type { MicBrowser, MicPlatform } from "@/types/mic.types";

const card = (
  code: string,
  platform: MicPlatform = "mac",
  browser: MicBrowser = "chrome",
  permission: "granted" | "prompt" | "denied" | "unknown" = "unknown",
) => micRecoveryCard({ code, platform, browser, permission });

const text = (c: { title: string; intro: string; steps: string[] }) =>
  [c.title, c.intro, ...c.steps].join(" ").toLowerCase();

describe("the incident — laptops never hear about phones or Siri", () => {
  it("S5: service-not-allowed on a MAC names System Settings and the browser, not Siri", () => {
    const c = card("service-not-allowed", "mac", "chrome");
    expect(c.scenario).toBe("os-blocked");
    expect(c.fixer).toBe("grown-up");
    expect(text(c)).toContain("system settings");
    expect(text(c)).toContain("privacy & security");
    expect(text(c)).toContain("chrome");
    expect(text(c)).not.toContain("siri");
    expect(text(c)).not.toMatch(/\bphone\b/); // "microphone" is fine; "phone" is not
  });

  it("S6: service-not-allowed on WINDOWS names the desktop-apps toggle", () => {
    const c = card("service-not-allowed", "windows", "edge");
    expect(c.scenario).toBe("os-blocked");
    expect(text(c)).toContain("desktop apps");
    expect(text(c)).toContain("microphone");
    expect(text(c)).not.toContain("siri");
    expect(text(c)).not.toContain("system settings"); // that's the Mac path
  });

  it("S7: the Siri/Dictation line survives ONLY on iOS", () => {
    const c = card("service-not-allowed", "ios", "safari");
    expect(c.scenario).toBe("os-blocked");
    expect(c.fixer).toBe("grown-up");
    expect(text(c)).toContain("dictation");
    expect(text(c)).not.toContain("system settings");
  });

  it("unknown platform gets honest generic steps, not a guessed device", () => {
    const c = card("service-not-allowed", "unknown", "other");
    expect(c.scenario).toBe("os-blocked");
    expect(text(c)).not.toContain("siri");
    expect(text(c)).not.toContain("system settings");
  });
});

describe("site-blocked (door 1, not-allowed)", () => {
  it("S2 desktop Chrome/Edge: lock-icon steps, kid-fixable", () => {
    const c = card("not-allowed", "mac", "chrome", "denied");
    expect(c.scenario).toBe("site-blocked");
    expect(c.fixer).toBe("kid");
    expect(text(c)).toContain("lock");
    expect(text(c)).toContain("allow");
  });

  it("S2 desktop Safari: names the Safari menu, not a lock icon", () => {
    const c = card("not-allowed", "mac", "safari", "denied");
    expect(text(c)).toContain("safari");
    expect(text(c)).toContain("microphone");
  });

  it("S3 Android: lock → Permissions → Microphone", () => {
    const c = card("not-allowed", "android", "chrome", "denied");
    expect(c.fixer).toBe("kid");
    expect(text(c)).toContain("permissions");
  });

  it("S4 iPhone/iPad Safari: the ᴀA route, grown-up flagged", () => {
    const c = card("not-allowed", "ios", "safari", "denied");
    expect(c.fixer).toBe("grown-up");
    expect(text(c)).toMatch(/ᴀa|settings/);
  });

  it("S1: a DISMISSED prompt is just a re-ask, no settings steps", () => {
    const c = card("not-allowed", "mac", "chrome", "prompt");
    expect(c.scenario).toBe("ask-again");
    expect(c.steps).toHaveLength(0);
    expect(text(c)).toContain("allow");
  });
});

describe("other scenarios", () => {
  it("S8 no-mic: hardware hint + typing as the way out", () => {
    const c = card("audio-capture", "mac", "chrome");
    expect(c.scenario).toBe("no-mic");
    expect(c.fixer).toBe("kid");
    expect(text(c)).toContain("type");
  });

  it("S9 network stays a simple kid-level card", () => {
    const c = card("network", "windows", "chrome");
    expect(c.scenario).toBe("network");
    expect(c.fixer).toBe("kid");
  });

  it("unknown codes fall back to a retry hiccup, never a blank", () => {
    const c = card("whatever-new-code", "mac", "chrome");
    expect(c.scenario).toBe("hiccup");
    expect(c.title.length).toBeGreaterThan(0);
  });

  it("every card has an icon, a title and a primary action label", () => {
    const codes = ["not-allowed", "service-not-allowed", "audio-capture", "network", "x"];
    const platforms: MicPlatform[] = ["mac", "windows", "chromeos", "android", "ios", "unknown"];
    for (const code of codes)
      for (const p of platforms) {
        const c = card(code, p);
        expect(c.icon.length).toBeGreaterThan(0);
        expect(c.title.length).toBeGreaterThan(0);
        expect(c.primaryLabel.length).toBeGreaterThan(0);
      }
  });
});

describe("pre-ask coach (wireframe A)", () => {
  it("tells the kid to choose Allow, with a friendly primary label", () => {
    const c = micAskCoachCard("mac");
    expect(c.scenario).toBe("ask-coach");
    expect(c.fixer).toBe("kid");
    expect(text(c)).toContain("allow");
    expect(c.primaryLabel).not.toBe("Try again"); // "Okay, ask me!"-style
  });
});
