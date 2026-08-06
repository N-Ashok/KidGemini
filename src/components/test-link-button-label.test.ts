import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Owner report 2026-08-06: the preview toolbar's "🎮 Invite" button read like
// it STARTS a multiplayer session, but it actually mints a temporary test
// link (mimics publishing so the game can be tried on another device before
// it's published). The label must say what it does — a test link — and never
// drift back to plain "Invite". Source-text pin, same style as
// sidebar-no-premium.test.ts.
describe("preview test-link button says 'test', not 'invite a session'", () => {
  const frame = readFileSync(path.join(__dirname, "ArtifactFrame.tsx"), "utf8");
  const sheet = readFileSync(path.join(__dirname, "InviteToTest.tsx"), "utf8");

  it("toolbar button is labelled as a test link", () => {
    expect(frame).toContain("Test link");
    expect(frame).not.toMatch(/>\s*Invite\s*</); // the old bare "Invite" label
  });

  it("aria-label says it's for trying the game out, not starting a session", () => {
    expect(frame).toMatch(/aria-label="[^"]*test link[^"]*"/i);
  });

  it("the sheet frames the link as a temporary test link (not a publish, expires)", () => {
    expect(sheet).toContain("test link");
    expect(sheet).toContain("2 hours");
  });

  // Owner UAT 2026-08-06 round 2: the link alone does not join two people
  // into one session — the sheet must teach open → tap 🎮 → host → forward
  // the room link, and offer opening the link directly (to host it yourself).
  it("the sheet teaches the host-then-forward flow instead of implying the link auto-joins", () => {
    expect(sheet).toMatch(/open the link, tap 🎮/i);
    expect(sheet).toContain("Invite a friend");
    expect(sheet).toContain("Open it and host");
    expect(sheet).not.toContain("They tap it, and you can both play together");
  });
});
