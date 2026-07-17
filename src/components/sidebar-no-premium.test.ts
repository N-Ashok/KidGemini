// 2026-07-11 pricing revamp: Ari no longer sells premium in the kid UI.
// Plans are sold on ariantra.com (Explorer / Assisted Starter / Assisted Pro),
// so the sidebar must NOT show a "Go premium" tab or link kids to /upgrade.
// The /upgrade route itself stays (parents can be deep-linked to it).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sidebar = readFileSync(join(__dirname, "Sidebar.tsx"), "utf8");

describe("sidebar has no Go premium tab (pricing lives on ariantra.com)", () => {
  it("does not render a Go premium entry", () => {
    expect(sidebar.toLowerCase()).not.toContain("go premium");
  });

  it("does not link kids to /upgrade from the sidebar", () => {
    expect(sidebar).not.toContain('"/upgrade"');
  });
});
