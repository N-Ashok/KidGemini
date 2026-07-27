// Pins the 2026-07-27 Sparks-packs pricing (Phase 5 payments; sold on
// ariantra.com/pricing.html, paid here):
//   pack120 ₹120 → 12,000 ⚡ (≈ 3–4 finished games)
//   pack200 ₹200 → 20,000 ⚡ (≈ 5–6 finished games)
//   pack500 ₹500 → 50,000 ⚡ (≈ 12–15 finished games, "Best value")
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

describe("Sparks packs (2026-07-27 Phase 5 pricing)", () => {
  it("sells exactly the three pricing.html packs", () => {
    expect(SPARK_PACKS.map((p) => p.key)).toEqual(["pack120", "pack200", "pack500"]);
  });

  it("pack120 is ₹120 for 12,000 Sparks", () => {
    const p = findPack("pack120");
    expect(p?.amountPaise).toBe(12_000);
    expect(p?.sparks).toBe(12_000);
  });

  it("pack200 is ₹200 for 20,000 Sparks", () => {
    const p = findPack("pack200");
    expect(p?.amountPaise).toBe(20_000);
    expect(p?.sparks).toBe(20_000);
  });

  it("pack500 is ₹500 for 50,000 Sparks", () => {
    const p = findPack("pack500");
    expect(p?.amountPaise).toBe(50_000);
    expect(p?.sparks).toBe(50_000);
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
