"use client";
// The Idea Queue (docs/PRD-IDEA-QUEUE.md): the line of ideas a kid typed while
// Ari was still building. Sits directly above the composer so "what I typed"
// and "where it went" are the same place on screen — a queued idea that showed
// up somewhere else would just read as a message that vanished.
//
// Presentational. All queue logic lives in lib/idea-queue.ts; this file only
// renders and raises events.

import type { QueuedIdea } from "@/types/idea-queue.types";

interface IdeaQueueProps {
  ideas: QueuedIdea[];
  /** The last turn was stopped or failed, so the line is frozen (owner
   *  decision 2026-07-24) — nothing auto-sends onto a possibly-broken game.
   *  Shows the "still want these?" choice instead. */
  paused: boolean;
  /** ✏️ commit-on-blur, same contract as the Idea Bag's rows. */
  onEdit: (id: string, text: string) => void;
  onDrop: (id: string) => void;
  /** "Yes, keep going" out of the paused state. */
  onResume: () => void;
  onDropAll: () => void;
}

export function IdeaQueue({ ideas, paused, onEdit, onDrop, onResume, onDropAll }: IdeaQueueProps) {
  if (!ideas.length) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="rounded-kid border border-brand-100 bg-brand-50 p-3">
        <p className="flex items-center gap-2 px-1 pb-2 text-sm font-extrabold text-neutral-700">
          {paused ? "⏸ Still want these?" : "⏳ Next up"}
          <span className="text-xs font-medium text-neutral-500">({ideas.length})</span>
          {!paused && (
            <span className="ml-auto text-xs font-medium text-neutral-500">
              Ari does these one at a time
            </span>
          )}
        </p>

        <ul className="flex flex-col gap-2">
          {ideas.map((idea, n) => (
            <li key={idea.id} className="flex items-start gap-2 rounded-kid bg-white px-2.5 py-2">
              <span
                aria-hidden
                className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-extrabold text-white"
              >
                {n + 1}
              </span>
              {/* Uncontrolled + commit on blur: the store rejects an empty edit
                  (updateQueuedIdea's trim-or-noop rule), so a controlled field
                  would snap back mid-retype whenever it was briefly empty. */}
              <textarea
                key={idea.id}
                aria-label={`Idea ${n + 1} — edit before Ari makes it`}
                defaultValue={idea.text}
                onBlur={(e) => onEdit(idea.id, e.target.value)}
                rows={1}
                className="min-h-[32px] min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-sm leading-snug text-neutral-800 outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                type="button"
                onClick={() => onDrop(idea.id)}
                aria-label={`Drop idea ${n + 1}`}
                title="Don't do this one"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        {/* A stop or a hiccup freezes the line. Auto-sending here would stack
            edits onto a game that may be half-built — so the kid decides. */}
        {paused && (
          <div className="flex flex-wrap items-center gap-2 pt-3">
            <button
              type="button"
              onClick={onResume}
              className="rounded-full bg-brand-500 px-4 py-2 text-sm font-extrabold text-white shadow-sm hover:bg-brand-600"
            >
              Yes — keep going ▶
            </button>
            <button
              type="button"
              onClick={onDropAll}
              className="rounded-full px-3 py-2 text-sm font-bold text-neutral-500 hover:text-neutral-700"
            >
              No thanks, drop them
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
