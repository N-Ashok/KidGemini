"use client";
// The Idea Bag (docs/PRD-IDEA-BUTTON.md): where spoken thoughts collect while
// a kid plays. Chip + badge over the preview; the panel lists idea cards with
// 🔊 read-aloud (pre-readers can check their own words) and one big
// "✨ Make my game better!" that bundles EVERYTHING into a single chat message.
// Presentational; store logic lives in lib/idea-bag.ts.

import { useState } from "react";
import { useTextToSpeech } from "./useTextToSpeech";

export interface BagIdea {
  id: string;
  text: string;
}

interface IdeaBagProps {
  ideas: BagIdea[];
  /** Streaming in progress — capture stays open, but ✨ waits its turn. */
  busy?: boolean;
  onDiscard: (id: string) => void;
  onMakeBetter: () => void;
}

export function IdeaBag({ ideas, busy, onDiscard, onMakeBetter }: IdeaBagProps) {
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
        className={`absolute bottom-3 left-3 z-20 flex min-h-[44px] items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-lg font-extrabold shadow-lg ${
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

      {/* The panel — over the game; playing resumes untouched on close. */}
      {open && count > 0 && (
        <div className="absolute inset-3 z-30 flex flex-col gap-2 overflow-hidden rounded-kid bg-white p-4 shadow-2xl md:inset-x-[12%] md:inset-y-[8%]">
          <p className="flex items-center gap-2 text-base font-extrabold text-neutral-800">
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
                <span className="min-w-0 flex-1 pt-1 text-sm leading-snug text-neutral-800">{idea.text}</span>
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
          <button
            type="button"
            onClick={() => {
              tts.stop();
              setOpen(false);
              onMakeBetter();
            }}
            disabled={busy}
            className="rounded-kid bg-brand-500 px-4 py-3 text-base font-extrabold text-white shadow-lg shadow-brand-500/30 hover:bg-brand-600 disabled:opacity-40"
          >
            {busy ? "🛠️ Still building the last one…" : "✨ Make my game better!"}
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
