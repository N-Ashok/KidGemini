"use client";
// The Idea Bag (docs/PRD-IDEA-BUTTON.md): where spoken thoughts collect while
// a kid plays. Chip + badge over the preview; the panel lists idea cards with
// 🔊 read-aloud (pre-readers can check their own words), ✏️ edit-in-place,
// and one big "✨ Make my game better!" that bundles EVERYTHING into a single
// chat message. Presentational; store logic lives in lib/idea-bag.ts.
//
// Panel redesign (2026-07-16): the old panel was a near-full-bleed sheet on
// mobile (`inset-3`) and a large 12%/8%-inset modal on desktop — flagged as
// "big and ugly." Replaced with a bottom sheet (mobile) / fixed 420px
// centered card (desktop, same width as the artifact panel itself —
// DESIGN_SYSTEM.md §10) — smaller, and it no longer covers the whole game.
// Also added the corner ✕ the mic tab's listening bar already had (this
// panel had no icon-close before, just the "Keep playing →" text link).

import { useState } from "react";
import { useTextToSpeech } from "./useTextToSpeech";

export interface BagIdea {
  id: string;
  text: string;
}

interface IdeaBagProps {
  ideas: BagIdea[];
  /** Streaming in progress — ✨ still works; it QUEUES the send (2026-07-21). */
  busy?: boolean;
  /** ✨ was tapped mid-build: the bundle is lined up to send when this turn
   *  finishes. Shows a reassuring "up next" affordance instead of silence. */
  queued?: boolean;
  onDiscard: (id: string) => void;
  /** ✏️ Fix a typo on an already-bagged idea (2026-07-16) — the row's own
   *  textarea is always editable (no separate edit-mode tap), so this just
   *  commits on blur. */
  onEditIdea: (id: string, text: string) => void;
  onMakeBetter: () => void;
}

export function IdeaBag({ ideas, busy, queued, onDiscard, onEditIdea, onMakeBetter }: IdeaBagProps) {
  const [open, setOpen] = useState(false);
  const tts = useTextToSpeech();
  const count = ideas.length;

  return (
    <>
      {/* The chip — bottom-left, above where games put their left control. */}
      <button
        type="button"
        onClick={() => count > 0 && setOpen(true)}
        disabled={count === 0}
        aria-label={count === 0 ? "Idea bag (empty)" : `Open your idea bag — ${count} ideas`}
        title={count === 0 ? "Say an idea with the 🎤 tab!" : "Your ideas"}
        className={`absolute bottom-3 left-3 z-20 flex min-h-[44px] items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-lg font-extrabold shadow-md ${
          count === 0 ? "opacity-50" : "hover:scale-105"
        }`}
      >
        🎒
        {count > 0 && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-danger-500 text-xs font-extrabold text-white">
            {count}
          </span>
        )}
      </button>

      {/* Queued reassurance (2026-07-21): the kid tapped ✨ mid-build — tell
          them it's lined up, so a busy send never looks like it did nothing. */}
      {queued && !open && (
        <div
          role="status"
          className="absolute bottom-3 left-16 z-20 flex min-h-[44px] items-center gap-1.5 rounded-full bg-brand-600 px-3.5 py-2 text-sm font-extrabold text-white shadow-md"
        >
          ⏳ Ari will add your ideas next!
        </div>
      )}

      {/* The panel — a bottom sheet on mobile, a small centered card on
          desktop; the game stays visible around it either way. */}
      {open && count > 0 && (
        <div
          className="absolute inset-x-3 bottom-3 top-auto z-30 flex max-h-[70%] flex-col gap-2 overflow-hidden rounded-kid bg-white p-4 shadow-lg
            md:inset-auto md:left-1/2 md:top-1/2 md:max-h-[80%] md:w-[420px] md:-translate-x-1/2 md:-translate-y-1/2"
        >
          <button
            type="button"
            onClick={() => {
              tts.stop();
              setOpen(false);
            }}
            aria-label="Close"
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            ✕
          </button>
          <p className="flex items-center gap-2 pr-8 text-base font-extrabold text-neutral-800">
            🎒 Your Idea Bag <span className="text-sm font-medium text-neutral-400">({count})</span>
          </p>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {ideas.map((idea) => (
              <li key={idea.id} className="flex items-start gap-2 rounded-kid bg-brand-50 px-3 py-2.5">
                {tts.isSupported && (
                  <button
                    type="button"
                    onClick={() =>
                      tts.activeId === idea.id && tts.state === "speaking"
                        ? tts.stop()
                        : tts.speak(idea.id, idea.text)
                    }
                    aria-label="Read this idea aloud"
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm text-white ${
                      tts.activeId === idea.id && tts.state === "speaking"
                        ? "mic-listening bg-brand-600"
                        : "bg-brand-500 hover:bg-brand-600"
                    }`}
                  >
                    🔊
                  </button>
                )}
                {/* Editable the moment you see it (2026-07-16) — no separate
                    "tap to edit" step. Uncontrolled (defaultValue, not value):
                    the store rejects an empty commit (updateIdeaText's
                    trim-or-noop rule), so a controlled textarea bound
                    straight to `idea.text` would visually snap back mid-typing
                    whenever the field was briefly empty (e.g. select-all to
                    retype). Committing on blur avoids that entirely. */}
                <textarea
                  key={idea.id}
                  aria-label="Your idea — edit anytime"
                  defaultValue={idea.text}
                  onBlur={(e) => onEditIdea(idea.id, e.target.value)}
                  rows={2}
                  className="min-w-0 flex-1 resize-none rounded-xl bg-white/60 px-2.5 py-1.5 text-sm leading-snug text-neutral-800 outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  type="button"
                  onClick={() => onDiscard(idea.id)}
                  aria-label="Throw this idea out"
                  title="Throw it out"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {/* Always enabled (2026-07-21): tapping while Ari builds QUEUES the
              send rather than sitting dead — the container fires it when the
              current turn lands. Label tells the kid which will happen. */}
          <button
            type="button"
            onClick={() => {
              tts.stop();
              setOpen(false);
              onMakeBetter();
            }}
            className="rounded-kid bg-brand-500 px-4 py-3 text-base font-extrabold text-white shadow-md shadow-brand-500/20 hover:bg-brand-600"
          >
            {busy ? "✨ Send these — Ari builds them next!" : "✨ Make my game better!"}
          </button>
          <button
            type="button"
            onClick={() => {
              tts.stop();
              setOpen(false);
            }}
            className="rounded-full py-1 text-sm font-bold text-neutral-500 hover:text-neutral-700"
          >
            Keep playing →
          </button>
        </div>
      )}
    </>
  );
}
