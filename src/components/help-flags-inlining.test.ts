// Regression test for the 2026-07-31 "SOS button flashes then vanishes" bug
// (docs/BUG_LOG.md). helpButtonEnabled()/helpNudgeEnabled() (lib/help-client.ts)
// default their `env` parameter to `process.env` and read a specific key off
// it INSIDE the function body — but Next.js only inlines a NEXT_PUBLIC_* var
// into the client bundle when the EXACT expression `process.env.NEXT_PUBLIC_X`
// appears literally in the source text. Calling `helpButtonEnabled()` with no
// argument never writes that literal expression at the call site, so the
// client bundle falls back to a generic `process/browser` polyfill with an
// EMPTY .env — the flag reads as permanently OFF in every browser, no matter
// what's actually configured, while the server (which has a real process.env)
// renders it correctly. That mismatch is the flash: the server-rendered HTML
// briefly shows the help affordance, then client hydration removes it.
//
// This can't be caught by calling the functions directly in a Vitest/Node
// environment — Node's process.env is the real one there too, so the bug is
// invisible to a logic-level test. What actually prevents a regression is
// pinning that the CALL SITE writes the literal `process.env.NEXT_PUBLIC_X`
// expression Next.js's build-time inlining looks for.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const source = readFileSync(join(__dirname, "ChatPanel.container.tsx"), "utf8");

describe("help-flag env inlining (BUG-FIX-LOG 2026-07-31)", () => {
  it("helpButtonEnabled() is called with the literal process.env expression, not bare", () => {
    expect(source).toContain("process.env.NEXT_PUBLIC_ENABLE_HELP_BUTTON");
  });

  it("helpNudgeEnabled() is called with the literal process.env expression, not bare", () => {
    expect(source).toContain("process.env.NEXT_PUBLIC_ENABLE_HELP_NUDGE");
  });

  it("neither flag call passes no arguments at all (the exact shape that broke)", () => {
    expect(source).not.toMatch(/helpButtonEnabled\(\s*\)/);
    expect(source).not.toMatch(/helpNudgeEnabled\(\s*\)/);
  });
});
