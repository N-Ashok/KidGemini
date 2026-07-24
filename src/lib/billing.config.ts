// Billing tunables only (Open/Closed: change plans/prices here, not at call sites).
// One-time charge model (Razorpay Orders) — chosen because the recurring Subscriptions API
// requires pre-created Plans we don't have yet. Amounts are in paise (₹1,200 = 120_000).
//
// 2026-07-11 pricing revamp: plans mirror ariantra.com's pricing section, which
// deep-links here as /upgrade?plan=<key> — keys are part of that public contract
// (pinned by billing.config.test.ts). All plans grant a year of platform access;
// entitlement differences (token caps, game limits) are not enforced yet ("rails
// only", see docs/PRD.md §8).

import type { BillingPlan } from "@/types/billing.types";

export const CURRENCY = "INR";

export const BILLING_PLANS: BillingPlan[] = [
  {
    key: "explorer",
    label: "Explorer",
    amountPaise: 120_000, // ₹1,200
    periodDays: 365,
    description: "₹1,200 / year — build on your own",
  },
  {
    key: "assisted4",
    label: "Assisted Starter",
    amountPaise: 399_000, // ₹3,990
    periodDays: 365,
    description: "₹3,990 — 4 live classes + 1 year unlimited",
  },
  {
    key: "assisted8",
    label: "Assisted Pro",
    amountPaise: 1_000_000, // ₹10,000
    periodDays: 365,
    description: "₹10,000 — 8 live classes + 1 year unlimited",
  },
];

export function findPlan(key: string): BillingPlan | undefined {
  return BILLING_PLANS.find((p) => p.key === key);
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
