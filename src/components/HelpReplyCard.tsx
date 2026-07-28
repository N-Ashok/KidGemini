"use client";
// A helper's reply, in the chat where the child got stuck
// (docs/PRD-COMMUNITY-HELP.md §3.8).
//
// Four constraints are visible in this component, and they're the reason an
// adult writing to a child is defensible here at all:
//
//  1. ATTRIBUTED HONESTLY — "A helper at Ariantra" with a slate rail and a
//     shield mark. Never styled as Ari (brand-blue bubble), never as another
//     kid. Kids should learn the difference between the AI, a helper and a
//     stranger; the UI teaches it rather than blurring it.
//  2. ONE-WAY — exactly two taps, no text field. 😕 reopens the ticket without
//     the child writing anything, so no open channel to an adult is created.
//  3. PARENT-MIRRORED — stated on the card, because a child should know an
//     adult they trust can read this too.
//  4. ANONYMOUS HELPER — the API never sends authorRef, so there is nothing
//     here to render even by accident.

import { sentAgoLabel } from "@/lib/help-client";
import type { HelpTicketView } from "@/lib/help-client";

interface HelpReplyCardProps {
  ticket: HelpTicketView;
  /** 👍 closes · 😕 reopens. The only thing the child can send back. */
  onJudge: (helped: boolean) => void;
  busy?: boolean;
}

export function HelpReplyCard({ ticket, onJudge, busy }: HelpReplyCardProps) {
  const reply = ticket.replies[ticket.replies.length - 1];
  if (!reply) return null;

  return (
    <div className="self-stretch rounded-2xl border border-neutral-200 border-l-4 border-l-ink-700 bg-white p-3 shadow-sm">
      <p className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-wide text-ink-700">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-md bg-neutral-100 text-xs"
          aria-hidden
        >
          🛡️
        </span>
        A helper at Ariantra
        <span className="ml-auto text-[11px] font-bold normal-case tracking-normal text-neutral-500">
          {sentAgoLabel(reply.createdAt, Date.now()).replace("sent ", "answered ")}
        </span>
      </p>

      <p className="mt-2 text-sm leading-relaxed text-neutral-900">{reply.body}</p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onJudge(true)}
          className="rounded-full bg-safe-500 px-4 py-2 text-sm font-extrabold text-white hover:bg-safe-600 disabled:opacity-50"
        >
          👍 That helped
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onJudge(false)}
          className="rounded-full bg-neutral-100 px-4 py-2 text-sm font-extrabold text-ink-700 hover:bg-neutral-200 disabled:opacity-50"
        >
          😕 Still stuck
        </button>
      </div>

      <p className="mt-2 text-[11px] text-neutral-500">
        Your grown-up can read this in the Parent area.
      </p>
    </div>
  );
}
