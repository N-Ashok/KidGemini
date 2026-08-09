"use client";
// The 🆘 tab and its reason sheet (docs/PRD-COMMUNITY-HELP.md §3.2/§3.3).
//
// Docked on the preview BELOW the 🎤 Idea tab and deliberately quieter than it
// (40px white circle vs the mic's 46px solid brand): the Idea Button is the
// happy path and must stay the more prominent affordance. Same dock grammar
// though — circular icon with an always-visible caption underneath, never a
// hover-only tooltip, because a hover tooltip is invisible on touch
// (BUG-FIX-LOG 2026-07-14, the lesson the mic tab already paid for).
//
// No typing required anywhere: six picture reasons, each with 🔊 read-aloud, so
// a pre-reader can file a ticket unassisted. "Something else" hands over to the
// same speech path the Idea Button uses.
//
// Presentational + local sheet state only. The decision to NUDGE lives in
// lib/stuck-signal.ts, the ticket state in lib/help-client.ts.

import { useEffect, useState } from "react";
import { HELP_CAPTURE_NOTICE, HELP_NUDGE } from "@/lib/chat-copy";
import { composeDictation } from "@/lib/speech-transcript";
import type { HelpReasonCode } from "@/types/help.types";
import { MicRecoveryCard } from "./MicRecoveryCard";
import { useSpeechInput } from "./useSpeechInput";
import { useTextToSpeech } from "./useTextToSpeech";

interface ReasonChip {
  code: HelpReasonCode;
  emoji: string;
  label: string;
}

const REASONS: ReasonChip[] = [
  { code: "wont_move", emoji: "🕹️", label: "It won't move" },
  { code: "blank", emoji: "⬜", label: "Screen is blank" },
  { code: "looks_wrong", emoji: "🎨", label: "It looks wrong" },
  { code: "no_sound", emoji: "🔇", label: "No sound" },
  { code: "dont_know", emoji: "🤷", label: "I don't know what to ask" },
  { code: "other", emoji: "🎤", label: "Something else" },
];

// No "try repair first" step: the self-healing loop already runs to exhaustion
// on every generation before a kid can tap 🆘 (see lib/stuck-signal.ts), so
// PRD §3.1 is satisfied structurally and a manual repair button would be
// theatre.
type Sheet = "closed" | "reasons" | "mic";

interface HelpTabProps {
  /** File the ticket. The container owns the POST, the retry and the copy. */
  onFile: (reasonCode: HelpReasonCode, transcript?: string) => void;
  /** One-time proactive offer for this generation (stuck-signal.ts). */
  nudge?: boolean;
  /** The nudge has been shown — never again for this generation. */
  onNudgeShown?: () => void;
  /** 🤷 "I don't know what to ask" is a content gap, not a defect — it goes to
   *  the Phase 2 gallery instead of the queue. */
  onBrowseHelp?: () => void;
  /** A ticket for this chat is already with a helper. */
  waiting?: boolean;
}

export function HelpTab({ onFile, nudge, onNudgeShown, onBrowseHelp, waiting }: HelpTabProps) {
  const [sheet, setSheet] = useState<Sheet>("closed");
  const [draft, setDraft] = useState("");
  const tts = useTextToSpeech();

  // `error`/`tryAgain` were omitted here, so this surface rendered no
  // MicRecoveryCard at all — and start() intercepts the FIRST call per mount
  // when permission is "prompt", setting the coach card and returning WITHOUT
  // starting. A child tapping 🆘 → "Something else" on a device that hasn't
  // granted the mic saw "Tap send when you're done", nothing listened, nothing
  // explained, and ✅ filed a wordless help ticket. Every fatal mic error
  // (denied, no hardware) was equally invisible (code review 2026-08-09).
  const {
    isListening, isSupported, interim, clearError, start, discardAndStop,
    error: micError, tryAgain: micTryAgain,
  } = useSpeechInput((text) => setDraft((v) => (v ? `${v} ${text}` : text)));
  const said = composeDictation(draft, interim);

  // The nudge is spent the moment it's rendered — one per generation, whether
  // or not the kid acts on it.
  useEffect(() => {
    if (nudge) onNudgeShown?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge]);

  // Leaving the sheet must never leave the mic running.
  useEffect(() => () => discardAndStop(), [discardAndStop]);

  function openSheet() {
    setSheet("reasons");
  }

  function closeSheet() {
    discardAndStop();
    setDraft("");
    tts.stop();
    setSheet("closed");
  }

  function pick(code: HelpReasonCode) {
    if (code === "dont_know" && onBrowseHelp) {
      closeSheet();
      onBrowseHelp();
      return;
    }
    if (code === "other") {
      if (!isSupported) {
        // No mic on this device: send the ticket without words rather than
        // dead-ending on an affordance that can't work here.
        closeSheet();
        onFile("other");
        return;
      }
      clearError();
      setDraft("");
      setSheet("mic");
      start();
      return;
    }
    closeSheet();
    onFile(code);
  }

  function sendSpoken() {
    const text = said.trim();
    discardAndStop();
    setSheet("closed");
    setDraft("");
    onFile("other", text || undefined);
  }

  return (
    <>
      {/* The dock: quieter sibling of the 🎤 tab, offset below it. */}
      <div className="absolute right-3 top-[calc(8%+76px)] z-20 flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={openSheet}
          aria-label="Ask a grown-up at Ariantra for help"
          title="Get help"
          className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-white/80 bg-white text-base shadow-md outline-none transition-colors hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-2"
        >
          {waiting ? "⏳" : "🆘"}
        </button>
        <span
          aria-hidden
          className="rounded-full bg-white px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-neutral-500 shadow-sm"
        >
          {waiting ? "Sent" : "Help"}
        </span>
      </div>

      {/* One-time offer. Never modal — the kid can ignore it and keep playing. */}
      {nudge && sheet === "closed" && !waiting && (
        <div className="absolute right-16 top-[calc(8%+62px)] z-30 w-[min(230px,68%)] rounded-kid bg-white p-3 shadow-lg">
          <p className="text-sm font-extrabold leading-snug text-neutral-800">{HELP_NUDGE}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={openSheet}
              className="rounded-full bg-brand-500 px-4 py-2 text-sm font-extrabold text-white hover:bg-brand-600"
            >
              Yes please
            </button>
            <button
              type="button"
              onClick={() => onNudgeShown?.()}
              className="rounded-full px-3 py-2 text-sm font-bold text-neutral-500 hover:bg-neutral-100"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {sheet !== "closed" && (
        <>
          <div className="absolute inset-0 z-[25] bg-ink-900/45" onClick={closeSheet} aria-hidden />
          <div
            role="dialog"
            aria-label="Get help with this game"
            className="absolute inset-x-0 bottom-0 z-30 rounded-t-kid bg-white p-4 shadow-lg"
          >
            <button
              type="button"
              onClick={closeSheet}
              aria-label="Close"
              className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
            >
              ✕
            </button>

            {sheet === "reasons" && (
              <>
                <h4 className="text-base font-extrabold text-neutral-900">What&apos;s going wrong? 🆘</h4>
                <p className="mb-2 mt-0.5 text-sm font-semibold text-neutral-500">
                  Tap a picture. Tap 🔊 to hear it.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {REASONS.map((r) => (
                    <div
                      key={r.code}
                      className="flex items-center gap-1 rounded-kid border-2 border-brand-100 pr-1"
                    >
                      <button
                        type="button"
                        onClick={() => pick(r.code)}
                        className="flex flex-1 items-center gap-2 rounded-kid px-2 py-2 text-left text-sm font-extrabold text-neutral-900 hover:bg-brand-50"
                      >
                        <span className="text-lg leading-none" aria-hidden>
                          {r.emoji}
                        </span>
                        {r.label}
                      </button>
                      <button
                        type="button"
                        aria-label={`Hear "${r.label}"`}
                        onClick={() =>
                          tts.activeId === r.code && tts.state !== "idle"
                            ? tts.stop()
                            : tts.speak(r.code, r.label)
                        }
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs text-brand-600"
                      >
                        🔊
                      </button>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-snug text-neutral-500">{HELP_CAPTURE_NOTICE}</p>
              </>
            )}

            {sheet === "mic" && (
              <>
                <h4 className="text-base font-extrabold text-neutral-900">Tell me what&apos;s wrong 🎤</h4>
                <p className="mb-2 mt-0.5 text-sm font-semibold text-neutral-500">
                  Say it out loud — I&apos;ll write it down.
                </p>
                <div className="rounded-kid bg-brand-50 p-3">
                  {micError && !isListening && (
                    <div className="mb-2">
                      <MicRecoveryCard
                        card={micError}
                        onPrimary={micTryAgain}
                        onDismiss={clearError}
                        onTypeInstead={clearError}
                      />
                    </div>
                  )}
                  <p className="flex items-center gap-2 text-sm font-extrabold text-neutral-900">
                    <span
                      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger-500 text-sm text-white ${
                        isListening ? "mic-listening" : ""
                      }`}
                      aria-hidden
                    >
                      🎤
                    </span>
                    {/* Don't claim "tap send when you're done" when nothing is
                        listening and there's no error to explain why. */}
                    {isListening
                      ? "I'm listening…"
                      : micError
                        ? "The mic didn't start"
                        : "Getting the mic ready…"}
                  </p>
                  <p className="mt-2 min-h-[2.5rem] rounded-xl bg-white px-3 py-2 text-sm text-neutral-700">
                    {said || <span className="text-neutral-400">…</span>}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={sendSpoken}
                      className="flex-1 rounded-full bg-brand-500 px-4 py-2 text-sm font-extrabold text-white hover:bg-brand-600"
                    >
                      ✅ Send it
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDraft("");
                        clearError();
                        start();
                      }}
                      className="rounded-full bg-brand-50 px-4 py-2 text-sm font-extrabold text-brand-700 hover:bg-brand-100"
                    >
                      🗑️ Start over
                    </button>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-snug text-neutral-500">
                  Nothing is sent until you tap ✅. {HELP_CAPTURE_NOTICE}
                </p>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}
