import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Owner ask 2026-08-06: the parent Sparks Management tab showed the balance
// and the full statement but offered NO way to buy — the entire billing stack
// (/upgrade → Razorpay → creditPurchase) had shipped 2026-07-27 reachable by
// direct link only, so the tab promised "money things come to you" with no
// money action. The parent card must link to /upgrade; the kid UI must keep
// NOT linking to it (sidebar-no-premium.test.ts guards that half).
describe("parent Sparks tab has a Buy Sparks path", () => {
  const card = readFileSync(path.join(__dirname, "SparksParentCard.tsx"), "utf8");

  it("links to the /upgrade checkout page", () => {
    expect(card).toContain('"/upgrade"');
  });

  it("the CTA says it's about buying/topping up Sparks", () => {
    expect(card).toMatch(/Buy Sparks/i);
  });
});
