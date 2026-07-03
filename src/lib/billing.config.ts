// Billing tunables only (Open/Closed: change plans/prices here, not at call sites).
// One-time charge model (Razorpay Orders) — chosen because the recurring Subscriptions API
// requires pre-created Plans we don't have yet. Amounts are in paise (₹699 = 69_900).
// Prices follow docs/PRD.md §8 (₹699/mo, ~₹6,000/yr annual).

import type { BillingPlan } from "@/types/billing.types";

export const CURRENCY = "INR";

export const BILLING_PLANS: BillingPlan[] = [
  {
    key: "monthly",
    label: "Monthly",
    amountPaise: 69_900, // ₹699
    periodDays: 30,
    description: "₹699 / month",
  },
  {
    key: "annual",
    label: "Annual",
    amountPaise: 600_000, // ₹6,000
    periodDays: 365,
    description: "₹6,000 / year — best value",
  },
];

export function findPlan(key: string): BillingPlan | undefined {
  return BILLING_PLANS.find((p) => p.key === key);
}
