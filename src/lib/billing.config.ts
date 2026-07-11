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
