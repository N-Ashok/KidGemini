// BUG-FIX-LOG 2026-07-10 "footer scroll trap": the root layout rendered
// ArFooter below the full-height chat screen, and the chat message list
// swallowed the upward scroll — once a kid reached the footer there was no
// way back. The footer must NEVER be in the root layout (the chat is an app
// screen); grown-up pages carry it via their own layouts, and the legal
// links stay reachable from the chat via the composer disclaimer line.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = (p: string) => readFileSync(join(__dirname, p), "utf8");

describe("footer placement (scroll-trap regression)", () => {
  it("root layout does NOT render the footer under the chat", () => {
    expect(app("layout.tsx")).not.toContain("ArFooter");
  });

  it("grown-up pages (/parent, /admin, /upgrade) each render the footer", () => {
    for (const route of ["parent", "admin", "upgrade"]) {
      expect(app(`${route}/layout.tsx`)).toContain("<ArFooter />");
    }
  });

  it("chat keeps Terms & Privacy reachable via the composer line", () => {
    const composer = readFileSync(
      join(__dirname, "../components/Composer.tsx"),
      "utf8",
    );
    expect(composer).toContain("terms.html");
    expect(composer).toContain("privacy.html");
  });
});
