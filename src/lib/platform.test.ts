// Platform/browser detection for mic-recovery copy (BUG-FIX-LOG 2026-07-20
// "laptop told to fix Siri"). Pure — signals injected, no navigator.
import { describe, it, expect } from "vitest";
import { detectPlatform, detectBrowser } from "./platform";
import type { PlatformSignals } from "@/types/mic.types";

const sig = (over: Partial<PlatformSignals>): PlatformSignals => ({
  userAgent: "",
  ...over,
});

describe("detectPlatform", () => {
  it("trusts userAgentData.platform where present (Chromium)", () => {
    expect(detectPlatform(sig({ uaDataPlatform: "macOS" }))).toBe("mac");
    expect(detectPlatform(sig({ uaDataPlatform: "Windows" }))).toBe("windows");
    expect(detectPlatform(sig({ uaDataPlatform: "Chrome OS" }))).toBe("chromeos");
    expect(detectPlatform(sig({ uaDataPlatform: "Android" }))).toBe("android");
  });

  it("falls back to the UA string (Safari, Firefox)", () => {
    expect(
      detectPlatform(sig({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15" })),
    ).toBe("mac");
    expect(detectPlatform(sig({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }))).toBe("windows");
    expect(detectPlatform(sig({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" }))).toBe("android");
    expect(detectPlatform(sig({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)" }))).toBe("ios");
    expect(detectPlatform(sig({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)" }))).toBe("chromeos");
  });

  it("iPadOS masquerading as a Mac (touch) is iOS — its settings are iOS settings", () => {
    expect(
      detectPlatform(
        sig({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", maxTouchPoints: 5 }),
      ),
    ).toBe("ios");
    // A real Mac (0/undefined touch points) stays a Mac.
    expect(
      detectPlatform(sig({ uaDataPlatform: "macOS", maxTouchPoints: 0 })),
    ).toBe("mac");
  });

  it("unrecognized → unknown, never a guess", () => {
    expect(detectPlatform(sig({ userAgent: "SomethingElse/1.0" }))).toBe("unknown");
  });
});

describe("detectBrowser", () => {
  it("prefers userAgentData brands (Edge ships Chrome brand too — Edge wins)", () => {
    expect(detectBrowser(sig({ brands: ["Chromium", "Google Chrome"] }))).toBe("chrome");
    expect(detectBrowser(sig({ brands: ["Chromium", "Microsoft Edge"] }))).toBe("edge");
  });

  it("UA fallback: Edg/ before Chrome/, Safari only without Chrome", () => {
    expect(detectBrowser(sig({ userAgent: "... Chrome/126.0 Safari/537.36 Edg/126.0" }))).toBe("edge");
    expect(detectBrowser(sig({ userAgent: "... Chrome/126.0 Safari/537.36" }))).toBe("chrome");
    expect(detectBrowser(sig({ userAgent: "... Version/17.5 Safari/605.1.15" }))).toBe("safari");
    expect(detectBrowser(sig({ userAgent: "... CriOS/126.0 Mobile/15E148 Safari/604.1" }))).toBe("chrome");
    expect(detectBrowser(sig({ userAgent: "Mozilla/5.0 Firefox/128.0" }))).toBe("other");
  });
});
