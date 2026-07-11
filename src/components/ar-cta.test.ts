// 2026-07-11 CTA revamp (mirrors Ariantra-Platform nav-links.ts CREATE_CTA/SPEAK_CTA):
// primary CTA everywhere = create a game (here that's a new chat, so "/"),
// secondary = click-to-call +91 72044 04452. The old WhatsApp-booking CTA and the
// old 88003 64622 number must not reappear on shared chrome.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

describe("shared chrome CTAs (2026-07-11 revamp)", () => {
  it("ArNav's loud CTA starts a game, not a WhatsApp booking", () => {
    const nav = read("ArNav.tsx");
    expect(nav).toContain("Create your first game");
    expect(nav).not.toContain("Book a free session");
  });

  it("ArFooter offers click-to-call on the current number", () => {
    const footer = read("ArFooter.tsx");
    expect(footer).toContain("tel:+917204404452");
    expect(footer).toContain("72044 04452");
  });

  it("the old phone number is gone from shared chrome", () => {
    for (const f of ["ArNav.tsx", "ArFooter.tsx"]) {
      expect(read(f)).not.toContain("8800364622");
      expect(read(f)).not.toContain("88003 64622");
    }
  });
});
