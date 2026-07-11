// Pins the 2026-07-11 pricing revamp (sold on ariantra.com, paid here):
//   explorer  ₹1,200 / year — self-serve, fair-use limits
//   assisted4 ₹3,990 — 4 live classes + 1yr unlimited create/publish
//   assisted8 ₹10,000 — 8 live classes + 1yr unlimited create/publish, very high AI usage
// Amounts are in paise. ariantra.com's pricing section deep-links to
// /upgrade?plan=<key> — renaming a key breaks those links, so keys are pinned here.
import { describe, it, expect } from "vitest";
import { BILLING_PLANS, findPlan } from "./billing.config";

describe("billing plans (2026-07-11 pricing)", () => {
  it("sells exactly the three ariantra.com tiers", () => {
    expect(BILLING_PLANS.map((p) => p.key)).toEqual(["explorer", "assisted4", "assisted8"]);
  });

  it("explorer is ₹1,200 for a year", () => {
    const p = findPlan("explorer");
    expect(p?.amountPaise).toBe(120_000);
    expect(p?.periodDays).toBe(365);
  });

  it("assisted4 is ₹3,990 with a year of platform access", () => {
    const p = findPlan("assisted4");
    expect(p?.amountPaise).toBe(399_000);
    expect(p?.periodDays).toBe(365);
  });

  it("assisted8 is ₹10,000 with a year of platform access", () => {
    const p = findPlan("assisted8");
    expect(p?.amountPaise).toBe(1_000_000);
    expect(p?.periodDays).toBe(365);
  });

  it("old plan keys are gone", () => {
    expect(findPlan("monthly")).toBeUndefined();
    expect(findPlan("annual")).toBeUndefined();
  });
});
