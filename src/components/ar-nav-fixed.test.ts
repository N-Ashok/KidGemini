// The nav is ALWAYS VISIBLE (owner call 2026-07-29, reversing the one-day-old
// chat-page auto-hide from 2026-07-28: "it is an useless thing let the nav menu
// be fixed").
//
// Pinned in two places on purpose. Removing the CSS alone would leave a React
// class name that does nothing; removing the class alone would leave live CSS
// that a stray class name could resurrect. This test fails if either comes back.
//
// Source-reading test, same pattern as ar-cta.test.ts — this repo's vitest runs
// in the node environment, so there is no DOM to render ArNav into.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nav = readFileSync(join(__dirname, "ArNav.tsx"), "utf8");
const brandCss = readFileSync(
  join(__dirname, "..", "..", "public", "brand", "ariantra-brand.v1.css"),
  "utf8",
);

describe("ArNav never hides itself", () => {
  it("N.1 renders a plain .ar-nav — no auto-hide or revealed modifier", () => {
    expect(nav).toContain('className="ar-nav"');
    expect(nav).not.toContain("ar-nav--auto-hide");
    expect(nav).not.toContain("ar-nav--revealed");
  });

  it("N.2 has no hover strip to fish the bar back out of", () => {
    expect(nav).not.toContain("ar-nav-hover-strip");
  });

  it("N.3 has no reveal/hide timers left behind", () => {
    expect(nav).not.toMatch(/INITIAL_REVEAL_MS|HIDE_GRACE_MS|scheduleHide/);
  });

  it("N.4 doesn't reveal the nav on pointer or focus events", () => {
    // onMouseEnter/onMouseLeave on the <header> were the auto-hide's triggers.
    expect(nav).not.toMatch(/onMouseEnter|onMouseLeave/);
  });
});

describe("the generated brand kit has no auto-hide rules", () => {
  it("N.5 defines neither .ar-nav--auto-hide nor .ar-nav-hover-strip", () => {
    // Prose in the header comment is fine; a RULE is not.
    expect(brandCss).not.toMatch(/\.ar-nav--auto-hide\s*(\.|,|\{)/);
    expect(brandCss).not.toMatch(/\.ar-nav-hover-strip\s*\{/);
  });

  it("N.6 still styles the nav itself — this removed a behaviour, not the bar", () => {
    expect(brandCss).toMatch(/\.ar-nav\s*\{/);
    expect(brandCss).toContain("--ar-z-nav");
  });
});
