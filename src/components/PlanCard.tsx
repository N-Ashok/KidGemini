"use client";
// Presentational plan card for the upgrade page. Renders one BillingPlan and raises onSelect.

import type { BillingPlan } from "@/types/billing.types";

interface PlanCardProps {
  plan: BillingPlan;
  highlight?: boolean;
  busy?: boolean;
  onSelect: () => void;
}

export function PlanCard({ plan, highlight = false, busy = false, onSelect }: PlanCardProps) {
  return (
    <div
      className={`flex w-full max-w-xs flex-col rounded-kid border p-6 text-center shadow-sm
        ${highlight ? "border-neutral-800" : "border-neutral-200"}`}
    >
      {highlight && (
        <span className="mx-auto mb-2 rounded-full bg-neutral-800 px-3 py-0.5 text-xs font-medium text-white">
          Most popular
        </span>
      )}
      <h2 className="text-lg font-semibold text-neutral-800">{plan.label}</h2>
      <p className="mt-2 text-2xl font-bold text-neutral-900">{plan.description}</p>
      <button
        onClick={onSelect}
        disabled={busy}
        className="mt-6 flex items-center justify-center gap-2 rounded-full bg-neutral-800 px-4 py-3
                   text-base font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {busy ? "Opening…" : "Choose plan"}
      </button>
    </div>
  );
}
