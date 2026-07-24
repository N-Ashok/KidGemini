// Pins the 2026-07-11 pricing revamp (sold on ariantra.com, paid here):
//   explorer  ₹1,200 / year — self-serve, fair-use limits
//   assisted4 ₹3,990 — 4 live classes + 1yr unlimited create/publish
//   assisted8 ₹10,000 — 8 live classes + 1yr unlimited create/publish, very high AI usage
// Amounts are in paise. ariantra.com's pricing section deep-links to
// /upgrade?plan=<key> — renaming a key breaks those links, so keys are pinned here.
import { describe, it, expect } from "vitest";
import {
  BILLING_PLANS,
  findPlan,
  validateCustomAmountPaise,
  rupeesToPaise,
  CUSTOM_AMOUNT_MIN_PAISE,
  CUSTOM_AMOUNT_MAX_PAISE,
  CUSTOM_PLAN_KEY,
} from "./billing.config";

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

  it("the custom sentinel is NOT a real plan (so it grants no entitlement)", () => {
    expect(findPlan(CUSTOM_PLAN_KEY)).toBeUndefined();
  });
});

describe("validateCustomAmountPaise — server authority on a pay-any-amount charge", () => {
  it("accepts a clean amount inside the range", () => {
    expect(validateCustomAmountPaise(100)).toBe(100); // ₹1 floor
    expect(validateCustomAmountPaise(50_000)).toBe(50_000); // ₹500
    expect(validateCustomAmountPaise(CUSTOM_AMOUNT_MAX_PAISE)).toBe(CUSTOM_AMOUNT_MAX_PAISE);
  });

  it("accepts a numeric string (JSON bodies stringify freely)", () => {
    expect(validateCustomAmountPaise("2500")).toBe(2500);
  });

  it("rejects below the ₹1 floor — Razorpay's hard minimum", () => {
    expect(validateCustomAmountPaise(99)).toBeNull();
    expect(validateCustomAmountPaise(0)).toBeNull();
  });

  it("rejects above the cap — the fat-finger guard", () => {
    expect(validateCustomAmountPaise(CUSTOM_AMOUNT_MAX_PAISE + 1)).toBeNull();
    expect(validateCustomAmountPaise(9_99_99_999)).toBeNull();
  });

  it("rejects negative, non-integer, and non-finite amounts (fail-closed)", () => {
    expect(validateCustomAmountPaise(-500)).toBeNull();
    expect(validateCustomAmountPaise(100.5)).toBeNull();
    expect(validateCustomAmountPaise(Number.NaN)).toBeNull();
    expect(validateCustomAmountPaise(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rejects junk input types", () => {
    expect(validateCustomAmountPaise("")).toBeNull();
    expect(validateCustomAmountPaise("abc")).toBeNull();
    expect(validateCustomAmountPaise(null)).toBeNull();
    expect(validateCustomAmountPaise(undefined)).toBeNull();
    expect(validateCustomAmountPaise({})).toBeNull();
  });
});

describe("rupeesToPaise — UI rupee→paise, no float drift", () => {
  it("converts whole rupees and paise", () => {
    expect(rupeesToPaise("1")).toBe(100);
    expect(rupeesToPaise("500")).toBe(50_000);
    expect(rupeesToPaise("10.50")).toBe(1050);
    expect(rupeesToPaise("0.99")).toBe(99);
  });

  it("rounds to paise granularity without float error", () => {
    expect(rupeesToPaise("10.10")).toBe(1010);
  });

  it("rejects negatives, >2 decimals, blanks, and junk", () => {
    expect(rupeesToPaise("-5")).toBeNull();
    expect(rupeesToPaise("1.234")).toBeNull();
    expect(rupeesToPaise("")).toBeNull();
    expect(rupeesToPaise("  ")).toBeNull();
    expect(rupeesToPaise("abc")).toBeNull();
    expect(rupeesToPaise("1e3")).toBeNull();
    expect(rupeesToPaise("0")).toBeNull();
  });
});
