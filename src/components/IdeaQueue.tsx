"use client";
// The Idea Queue (docs/PRD-IDEA-QUEUE-V2.md): ONE line for every idea a kid
// has while Ari is busy — typed rows ("build", numbered, one turn each) and
// spoken rows ("tweak", ✨, consecutive runs bundle into one turn). Rendered
// as the card above the composer AND inside the preview pane's bottom sheet
// (variant="sheet"), so the line is visible on whichever surface the kid is on.
//
// Presentational. All queue logic lives in lib/idea-queue.ts; this file only
// renders and raises events.

import { useEffect, useRef, useState } from "react";
import type { QueueHold, QueuedIdea } from "@/types/idea-queue.types";

interface IdeaQueueProps {
  ideas: QueuedIdea[];
  /** Why the line is not draining (PRD v2 §3.5). "failed"/"restored" both show
   *  the "still want these?" ask — nothing auto-sends onto a possibly-broken
   *  or unwatched game; only the explicit yes clears a "failed" hold. */
  hold: QueueHold;
  /** Idle tweaks wait a beat for the kid's next thought (PRD v2 §3.3) — say
   *  so, with an escape hatch, so the pause never reads as a hang. */
  settling?: boolean;
  onSendNow?: () => void;
  /** ✏️ commits on every non-empty change (NOT blur) — the drain reads live
   *  state, so a blur-only commit could send pre-edit text (PRD v2 §3.6). */
  onEdit: (id: string, text: string) => void;
  onDrop: (id: string) => void;
  /** "Yes, keep going" out of the held state. */
  onResume: () => void;
  onDropAll: () => void;
  /** "card" (default) = above the composer; "sheet" = inside the preview
   *  pane's bottom sheet, which owns positioning/backdrop. */
  variant?: "card" | "sheet";
}

export function IdeaQueue({ ideas, hold, settling, onSendNow, onEdit, onDrop, onResume, onDropAll, variant = "card" }: IdeaQueueProps) {
  if (!ideas.length) return null;

  const hasTweakRun = ideas.some((idea, n) => idea.kind === "tweak" && ideas[n + 1]?.kind === "tweak");

  const body = (
    <div className="rounded-kid border border-brand-100 bg-brand-50 p-3">
      <p className="flex items-center gap-2 px-1 pb-2 text-sm font-extrabold text-neutral-700">
        {hold ? "⏸ Still want these?" : "⏳ Next up"}
        <span className="text-xs font-medium text-neutral-500">({ideas.length})</span>
        {!hold && (
          <span className="ml-auto text-xs font-medium text-neutral-500">
            {hasTweakRun ? "✨ tweaks travel together" : "Ari does these one at a time"}
          </span>
        )}
      </p>

      <ul className="flex flex-col gap-2">
        {ideas.map((idea, n) => (
          <QueueRow key={idea.id} idea={idea} n={n} onEdit={onEdit} onDrop={onDrop} />
        ))}
      </ul>

      {/* Idle tweak settle (PRD v2 §3.3): the brief collect-your-thoughts wait
          is narrated, never a silent hang — and skippable. */}
      {settling && !hold && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          <p role="status" className="px-1 text-xs font-medium text-neutral-500">
            ✨ Sending in a moment — keep talking!
          </p>
          {onSendNow && (
            <button
              type="button"
              onClick={onSendNow}
              className="rounded-full bg-brand-500 px-3 py-1.5 text-xs font-extrabold text-white shadow-sm hover:bg-brand-600"
            >
              Send now ▶
            </button>
          )}
        </div>
      )}

      {/* A stop, a hiccup, or a restored chat freezes the line. Auto-sending
          here would stack edits onto a game that may be half-built (or build
          while nobody watches) — so the kid decides. */}
      {hold && (
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
  );

  if (variant === "sheet") return body;
  return <div className="mx-auto w-full max-w-3xl px-4">{body}</div>;
}

/** One waiting idea. Keeps a LOCAL draft committed upward on every non-empty
 *  change — v1's uncontrolled commit-on-blur meant an edit in progress at the
 *  exact moment of a drain sent the PRE-edit text (PRD v2 §3.6). The empty
 *  draft stays local (the store's trim-or-noop rule would snap a controlled
 *  field back mid-retype); external text changes (a cap-merge) sync in only
 *  while the row isn't focused. */
function QueueRow({
  idea,
  n,
  onEdit,
  onDrop,
}: {
  idea: QueuedIdea;
  n: number;
  onEdit: (id: string, text: string) => void;
  onDrop: (id: string) => void;
}) {
  const [draft, setDraft] = useState(idea.text);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setDraft(idea.text);
  }, [idea.text]);

  const isTweak = idea.kind === "tweak";
  return (
    <li className="flex items-start gap-2 rounded-kid bg-white px-2.5 py-2">
      <span
        aria-hidden
        title={isTweak ? "A tweak for the game on screen" : undefined}
        className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-extrabold ${
          isTweak ? "border border-brand-200 bg-brand-50 text-brand-600" : "bg-brand-500 text-white"
        }`}
      >
        {isTweak ? "✨" : n + 1}
      </span>
      <textarea
        aria-label={
          isTweak ? `Tweak ${n + 1} — edit before Ari makes it` : `Idea ${n + 1} — edit before Ari makes it`
        }
        value={draft}
        onFocus={() => (focusedRef.current = true)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value.trim()) onEdit(idea.id, e.target.value);
        }}
        onBlur={() => {
          focusedRef.current = false;
          setDraft(idea.text); // an emptied edit snaps back to the kept text
        }}
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
  );
}
