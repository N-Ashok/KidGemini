import { describe, it, expect } from "vitest";
import {
  MODEL_GLITCH_RETRY,
  blockedCategoryNames,
  adultSafetyBlockMessage,
} from "./chat-copy";

// Owner ask 2026-07-23: in Teacher mode (verified-adult bible-teacher persona) a
// provider safety block should give an HONEST, actionable answer — not the kid
// "tell me more" redirect, which doesn't help an adult author find a fix.

describe("blockedCategoryNames — which categories actually tripped the block", () => {
  it("names MEDIUM/HIGH categories in human-friendly form", () => {
    expect(blockedCategoryNames("HARASSMENT:MEDIUM, HATE_SPEECH:NEGLIGIBLE")).toEqual(["harassment"]);
    expect(blockedCategoryNames("HATE_SPEECH:HIGH, DANGEROUS_CONTENT:MEDIUM")).toEqual([
      "hate speech",
      "dangerous content",
    ]);
  });

  it("includes an explicitly (blocked)-marked category even at LOW", () => {
    expect(blockedCategoryNames("HARASSMENT:LOW(blocked), HATE_SPEECH:LOW")).toEqual(["harassment"]);
  });

  it("returns nothing when only LOW/NEGLIGIBLE ratings are present (message stays generic)", () => {
    expect(blockedCategoryNames("HARASSMENT:LOW, HATE_SPEECH:LOW")).toEqual([]);
    expect(blockedCategoryNames(undefined)).toEqual([]);
    expect(blockedCategoryNames("garbage")).toEqual([]);
  });
});

describe("adultSafetyBlockMessage — honest + actionable, unlike the kid redirect", () => {
  it("is NOT the kid 'tell me more' copy", () => {
    expect(adultSafetyBlockMessage("HARASSMENT:MEDIUM")).not.toBe(MODEL_GLITCH_RETRY);
  });

  it("says plainly it was a content-safety block and offers a concrete next step", () => {
    const msg = adultSafetyBlockMessage("HARASSMENT:MEDIUM");
    expect(msg).toMatch(/content-safety/i);
    expect(msg).toMatch(/higher level|rephras|wording|send it again/i);
  });

  it("names the tripped category when the provider reported one", () => {
    expect(adultSafetyBlockMessage("HARASSMENT:MEDIUM, HATE_SPEECH:NEGLIGIBLE")).toContain("harassment");
  });

  it("stays generic (no category) when nothing notable was reported", () => {
    const msg = adultSafetyBlockMessage("HARASSMENT:LOW, HATE_SPEECH:LOW");
    expect(msg).toMatch(/content-safety/i);
    expect(msg).not.toContain("harassment");
  });
});
