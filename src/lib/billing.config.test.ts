// Pins the 2026-08-01 Sparks-packs pricing (2 tiers, down from the earlier
// 2026-07-27 Phase 5 three-tier ladder; sold on the "Ariantra AI" marketing
// repo's pricing.html, paid here):
//   pack500  ₹500  → 50,000 ⚡  (≈ 12–15 finished games)
//   pack1000 ₹1000 → 1,00,000 ⚡ ("Best value") — SAME flat rate as pack500,
//     no bonus tier: 1 Spark = 1 paisa for both.
// Amounts are in paise. pricing.html's "Buy Sparks" deep-links to /upgrade —
// renaming a key breaks any future ?pack=<key> deep link, so keys are pinned
// here. Supersedes the 2026-07-11 yearly-plan tiers (explorer/assisted4/
// assisted8), which nothing on the live site links to anymore.
import { describe, it, expect } from "vitest";
import {
  SPARK_PACKS,
  findPack,
  validateCustomAmountPaise,
  rupeesToPaise,
  CUSTOM_AMOUNT_MIN_PAISE,
  CUSTOM_AMOUNT_MAX_PAISE,
  CUSTOM_PLAN_KEY,
} from "./billing.config";

describe("Sparks packs (2026-08-01 pricing)", () => {
  it("sells exactly the two pricing.html packs", () => {
    expect(SPARK_PACKS.map((p) => p.key)).toEqual(["pack500", "pack1000"]);
  });

  it("pack500 is ₹500 for 50,000 Sparks", () => {
    const p = findPack("pack500");
    expect(p?.amountPaise).toBe(50_000);
    expect(p?.sparks).toBe(50_000);
  });

  it("pack1000 is ₹1000 for 1,00,000 Sparks — same flat rate as pack500, no bonus", () => {
    const p = findPack("pack1000");
    expect(p?.amountPaise).toBe(100_000);
    expect(p?.sparks).toBe(100_000);
  });

  it("old yearly-plan keys are gone", () => {
    expect(findPack("explorer")).toBeUndefined();
    expect(findPack("assisted4")).toBeUndefined();
    expect(findPack("assisted8")).toBeUndefined();
    expect(findPack("monthly")).toBeUndefined();
  });

  it("the custom sentinel is NOT a real pack (so it grants no Sparks)", () => {
    expect(findPack(CUSTOM_PLAN_KEY)).toBeUndefined();
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
