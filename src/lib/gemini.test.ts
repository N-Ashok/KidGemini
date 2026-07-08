import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CHILD_SYSTEM_PROMPT } from "./gemini";

describe("CHILD_SYSTEM_PROMPT — sizing guidance (BUG-FIX-LOG 2026-07-08)", () => {
  it("requires 100dvh, never bare 100vh, for full-height sizing", () => {
    // Regression: a published game sized with 100vh gets its bottom on-screen
    // controls hidden behind a mobile browser's address bar (100vh doesn't
    // shrink for it; 100dvh does). This locks the prompt so that guidance
    // can't quietly regress back to plain vh.
    expect(CHILD_SYSTEM_PROMPT).toContain("height:100dvh");
    // Allows prose that WARNS against 100vh ("NEVER 100vh") — only bans it
    // appearing as an actual sizing instruction like "height:100vh" would.
    expect(CHILD_SYSTEM_PROMPT).not.toMatch(/height:\s*100vh/);
  });
});
