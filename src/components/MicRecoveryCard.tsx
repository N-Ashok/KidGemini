"use client";
// Renders a MicRecoveryCard (lib/mic-recovery.ts) — the device-aware "the
// mic can't listen, here's what to do" surface shared by the Composer and
// the preview's Idea Button (BUG-FIX-LOG 2026-07-20 "laptop told to fix
// Siri"). Presentational only: what to say is decided in lib.
//
// Kid-first decisions (owner, 2026-07-20): a CARD with numbered steps (not a
// one-line banner), an explicit "👋 Ask a grown-up" chip on OS-level fixes so
// a kid knows to hand off instead of failing alone, and every card ends in
// actions — Try again / type instead — never a dead end.

import type { MicRecoveryCard as Card } from "@/types/mic.types";

interface MicRecoveryCardProps {
  card: Card;
  /** Try again / "Okay, ask me!" — re-checks and starts the mic. */
  onPrimary: () => void;
  onDismiss: () => void;
  /** Focuses the text input; omitted where no composer is visible. */
  onTypeInstead?: () => void;
}

export function MicRecoveryCard({ card, onPrimary, onDismiss, onTypeInstead }: MicRecoveryCardProps) {
  return (
    <div className="relative rounded-kid border border-amber-200 bg-white p-4 shadow-md">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-neutral-400 hover:bg-neutral-100"
      >
        ✕
      </button>
      {card.fixer === "grown-up" && (
        <span className="mb-1 inline-flex items-center gap-1 rounded-full border border-dashed border-amber-300 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
          👋 Ask a grown-up
        </span>
      )}
      <div className="flex items-start gap-3">
        <span className="text-3xl leading-none" aria-hidden>
          {card.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-neutral-800">{card.title}</p>
          {card.intro && <p className="mt-0.5 text-sm text-neutral-600">{card.intro}</p>}
          {card.steps.length > 0 && (
            <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-neutral-700">
              {card.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onPrimary}
              className="rounded-full bg-orange-500 px-4 py-1.5 text-sm font-extrabold text-white shadow shadow-orange-500/30 hover:bg-orange-600"
            >
              {card.primaryLabel}
            </button>
            {onTypeInstead && (
              <button
                type="button"
                onClick={onTypeInstead}
                className="text-sm font-medium text-neutral-500 underline hover:text-neutral-700"
              >
                I&apos;ll type instead
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
