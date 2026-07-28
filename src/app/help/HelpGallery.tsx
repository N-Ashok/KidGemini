"use client";
// 📚 The Help Gallery (docs/PRD-COMMUNITY-HELP.md Phase 2).
//
// A place a stuck kid can browse for "how do I…", where every card ends in ONE
// TAP rather than a paragraph to read. That's what makes it usable by a
// pre-reader: they never compose the sentence, they only recognise the picture.
//
// Content is team-authored (lib/help-cards.ts) — no user-generated content, so
// there is nothing to moderate at runtime. Cards render as TEXT, never as HTML.

import { useState } from "react";
import { HELP_CARDS, type HelpCard } from "@/lib/help-cards";
import { saveHelpAsk } from "@/lib/help-ask";
import { useTextToSpeech } from "@/components/useTextToSpeech";

export function HelpGallery() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const tts = useTextToSpeech();

  function askAri(card: HelpCard) {
    setSending(card.id);
    // Handed over the one navigation; the chat sends it through the normal
    // /api/chat path on arrival. Same tab on purpose — a second tab is a worse
    // place for a kid to end up than the chat they came from.
    saveHelpAsk(window.localStorage, card.prompt);
    window.location.assign("/");
  }

  return (
    // pb-28 on mobile: ArNav's bottom tab bar is fixed, and without it the last
    // card sits under "Chat / Arcade / Toy Box…" (caught in the visual pass).
    <main className="mx-auto max-w-3xl px-4 pb-28 pt-8 sm:pb-8">
      <a
        href="/"
        className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-4 py-2 text-sm font-bold text-neutral-700 hover:bg-neutral-200"
      >
        ← Back to Ari
      </a>

      <h1 className="mt-4 font-display text-2xl font-bold text-neutral-900">Stuck? Try one of these 📚</h1>
      <p className="mt-1 text-neutral-600">
        Tap a card and I&apos;ll ask it for you — no typing needed.
      </p>

      <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {HELP_CARDS.map((card) => {
          const open = openId === card.id;
          const speaking = tts.activeId === card.id && tts.state !== "idle";
          return (
            <li
              key={card.id}
              className={`flex flex-col gap-2 rounded-kid border bg-white p-4 ${
                open ? "border-brand-300 shadow-md sm:col-span-2" : "border-neutral-200"
              }`}
            >
              <button
                type="button"
                onClick={() => setOpenId(open ? null : card.id)}
                aria-expanded={open}
                className="flex items-center gap-3 text-left"
              >
                <span
                  className={`flex shrink-0 items-center justify-center rounded-xl bg-brand-50 ${
                    open ? "h-16 w-16 text-3xl" : "h-12 w-12 text-2xl"
                  }`}
                  aria-hidden
                >
                  {card.emoji}
                </span>
                <span className="font-extrabold leading-snug text-neutral-900">{card.title}</span>
              </button>

              {open && (
                <p className="rounded-xl bg-brand-50 px-3 py-2 text-sm font-bold text-brand-700">
                  &ldquo;{card.prompt}&rdquo;
                </p>
              )}

              <div className="mt-auto flex items-center gap-2">
                <button
                  type="button"
                  disabled={sending === card.id}
                  onClick={() => askAri(card)}
                  className="flex-1 rounded-full bg-brand-500 px-4 py-2.5 text-sm font-extrabold text-white hover:bg-brand-600 disabled:opacity-60"
                >
                  {sending === card.id ? "Asking Ari…" : "✨ Ask Ari this"}
                </button>
                {tts.isSupported && (
                  <button
                    type="button"
                    aria-label={speaking ? "Stop" : `Hear "${card.title}"`}
                    onClick={() => (speaking ? tts.stop() : tts.speak(card.id, card.readAloud))}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600 hover:bg-brand-100"
                  >
                    {speaking ? "⏹" : "🔊"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-8 text-sm text-neutral-500">
        Still stuck? Tap 🆘 on your game and a grown-up at Ariantra will take a look.
      </p>
    </main>
  );
}
