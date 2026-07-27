// Billing tunables only (Open/Closed: change packs/prices here, not at call sites).
// One-time charge model (Razorpay Orders) — chosen because the recurring Subscriptions API
// requires pre-created Plans we don't have yet. Amounts are in paise (₹120 = 12_000).
//
// 2026-07-27 Phase 5 payments: SPARK_PACKS mirror ariantra.com/pricing.html's
// Sparks-pack table exactly (PRD-SPARKS.md closure plan). "Buy Sparks" links
// to /upgrade — keys are a public contract (pinned by billing.config.test.ts)
// in case a future deep link adds ?pack=<key>. Supersedes the 2026-07-11
// yearly-access plans (explorer/assisted4/assisted8): nothing on the live
// site links to those anymore, and the product model moved to Sparks
// metering (SparksService.debitUsage) rather than a periodDays gate that was
// never actually enforced ("rails only", docs/PRD.md §8).

import type { SparkPack } from "@/types/billing.types";

export const CURRENCY = "INR";

export const SPARK_PACKS: SparkPack[] = [
  {
    key: "pack120",
    label: "Starter pack",
    amountPaise: 12_000, // ₹120
    sparks: 12_000,
    description: "₹120 — 12,000 ⚡ (≈ 3–4 finished games)",
  },
  {
    key: "pack200",
    label: "Builder pack",
    amountPaise: 20_000, // ₹200
    sparks: 20_000,
    description: "₹200 — 20,000 ⚡ (≈ 5–6 finished games)",
  },
  {
    key: "pack500",
    label: "Best value",
    amountPaise: 50_000, // ₹500
    sparks: 50_000,
    description: "₹500 — 50,000 ⚡ (≈ 12–15 finished games)",
  },
];

export function findPack(key: string): SparkPack | undefined {
  return SPARK_PACKS.find((p) => p.key === key);
}

// ── Pay-what-you-want (the /pay page) ────────────────────────────────────────
// A signed-in user can pay an ARBITRARY amount (a top-up / donation), separate
// from the fixed plans above. Unlike a plan, the amount comes from the client —
// which is fine here because the payer is spending their OWN money (there is no
// "correct" price to tamper with). But it is still validated server-side:
//   • integer paise only (Razorpay rejects anything else)
//   • ≥ ₹1 — Razorpay's hard minimum (100 paise)
//   • ≤ a cap — a fat-finger / accidental-charge guard, NOT a security gate
//     (owner-chosen 2026-07-24; raise it here, never at the call site)
// A custom payment is recorded but grants NO entitlement (see CUSTOM_PLAN_KEY
// handling in verify/webhook + latestForUser) — otherwise ₹1 would buy a plan.
export const CUSTOM_AMOUNT_MIN_PAISE = 100; // ₹1 — Razorpay's floor
export const CUSTOM_AMOUNT_MAX_PAISE = 10_000_000; // ₹1,00,000 cap
/** Sentinel planKey for arbitrary-amount payments. Deliberately NOT a real plan
 *  key, so findPlan() returns undefined and no entitlement period is granted. */
export const CUSTOM_PLAN_KEY = "custom";

/** Validate a client-supplied custom amount in PAISE. Returns the integer paise
 *  if it's a clean value inside [MIN, MAX], else null. Fail-closed: anything
 *  non-finite, non-integer, or out of range → null. This is the server's
 *  authority on the amount — the browser's help is never trusted. */
export function validateCustomAmountPaise(input: unknown): number | null {
  const n =
    typeof input === "number"
      ? input
      : typeof input === "string" && input.trim() !== ""
        ? Number(input)
        : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < CUSTOM_AMOUNT_MIN_PAISE || n > CUSTOM_AMOUNT_MAX_PAISE) return null;
  return n;
}

/** UI helper: parse a rupee string/number to integer paise, or null if it isn't
 *  a clean positive money value (digits, optional up to 2 decimals). Centralises
 *  the rupee→paise math in ONE tested place so the browser and any display agree;
 *  the server still re-validates the result with validateCustomAmountPaise. */
export function rupeesToPaise(input: unknown): number | null {
  const s = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null; // no sign, no >2 decimals, no junk
  const paise = Math.round(Number(s) * 100);
  return Number.isInteger(paise) && paise > 0 ? paise : null;
}
