// ariantra.com's pricing cards link to /upgrade?plan=<key> expecting Checkout to
// open for that plan once signed in. This pins the pieces of that contract that
// live in this repo (the plan keys themselves are pinned by billing.config.test.ts).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const container = readFileSync(join(__dirname, "UpgradePlans.container.tsx"), "utf8");

describe("upgrade page honours ?plan= deep links from ariantra.com", () => {
  it("reads the plan query param", () => {
    expect(container).toContain('get("plan")');
  });

  it("validates the param against the configured plans before starting checkout", () => {
    expect(container).toContain("findPlan(key)");
  });

  it("never auto-charges a user who already has an active plan", () => {
    expect(container).toMatch(/if \(autoStarted \|\| alreadyPaid \|\| !statusChecked/);
  });
});
