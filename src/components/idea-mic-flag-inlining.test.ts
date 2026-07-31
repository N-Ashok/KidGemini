// Regression guard for the same build-time-inlining gotcha fixed in
// help-flags-inlining.test.ts (BUG-FIX-LOG 2026-07-31): Next.js only bakes a
// NEXT_PUBLIC_* value into the client bundle when the literal expression
// `process.env.NEXT_PUBLIC_X` appears at the call site — a bare
// `ideaMicEnabled()` call would read as permanently off in every browser.
// Not catchable at the logic level (Node's real process.env masks it), so
// this pins the call site's source text instead.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const source = readFileSync(join(__dirname, "ChatPanel.container.tsx"), "utf8");

describe("idea-mic flag env inlining (BUG-FIX-LOG 2026-07-31)", () => {
  it("ideaMicEnabled() is called with the literal process.env expression, not bare", () => {
    expect(source).toContain("process.env.NEXT_PUBLIC_ENABLE_IDEA_MIC");
  });

  it("is never invoked with zero arguments (the exact shape that broke the SOS button)", () => {
    expect(source).not.toMatch(/ideaMicEnabled\(\s*\)/);
  });
});
