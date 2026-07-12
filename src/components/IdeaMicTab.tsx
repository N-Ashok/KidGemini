"use client";
// The Idea Button (docs/PRD-IDEA-BUTTON.md): an edge-docked mic tab over the
// game preview so a kid who can't type can speak thoughts WHILE playing.
// Capture ≠ send: ✅ hands the transcript to the container's Idea Bag — no
// network, no generation, back to the game in seconds. Presentational; the
// tab state machine lives in lib/idea-mic.ts, speech in useSpeechInput.

import { useEffect, useRef, useState } from "react";
import { composeDictation } from "@/lib/speech-transcript";
import { nextMicTabState, TAB_AUTO_TUCK_MS, type MicTabState } from "@/lib/idea-mic";
import { COACH_LINE } from "@/lib/idea-coach";
import { useSpeechInput } from "./useSpeechInput";
import { useTextToSpeech } from "./useTextToSpeech";

interface IdeaMicTabProps {
  /** ✅ Got it! — the finished transcript, ready for the bag. */
  onIdea: (text: string) => void;
  /** First-run coach (docs/PRD-IDEA-BUTTON.md §coach): the tab introduces
      itself with a silent bubble + animation; voice only on the 🔊 Hear it
      button. Policy lives in the container; mic support is enforced HERE
      (no tab → no coach). */
  coach?: boolean;
  /** Intro finished (OK / tap-anywhere / tab tapped) — mark it seen. */
  onCoachDone?: () => void;
  /** The one wiggle-only reminder (no dim, no bubble, no voice). */
  nudge?: boolean;
  /** The reminder has played — never show it again. */
  onNudgeShown?: () => void;
}

// Same silence gap as the composer's dictation nudge (Composer.tsx).
const NUDGE_MS = 5000;
// The wiggle-only reminder runs two wiggle cycles (globals.css) then rests.
const RENUDGE_ANIM_MS = 3000;

export function IdeaMicTab({ onIdea, coach, onCoachDone, nudge, onNudgeShown }: IdeaMicTabProps) {
  const [tab, setTab] = useState<MicTabState>("tucked");
  // Committed (finalized) speech for the CURRENT capture; interim rides on top.
  const [draft, setDraft] = useState("");
  // Vertical position of the tab along the preview edge (% of height) — games
  // put controls in corners, so the kid can drag the tab out of the way.
  const [topPct, setTopPct] = useState(42);
  const dragRef = useRef<{ startY: number; startPct: number; moved: boolean } | null>(null);

  const {
    isListening,
    isSupported,
    error: micError,
    interim,
    clearError,
    start,
    discardAndStop,
  } = useSpeechInput((text) => setDraft((v) => (v ? `${v} ${text}` : text)));

  const display = composeDictation(draft, interim);

  // ── First-run coach ────────────────────────────────────────────────────
  // The bubble text + demo animation ARE the onboarding — no auto voice-over
  // (it startled more than it taught). A pre-reader (or anyone) can tap
  // 🔊 Hear it to have the line read aloud; any dismissal stops the voice.
  // The coach never blocks the feature — tapping the tab dismisses it AND
  // starts real listening.
  const coachActive = Boolean(coach) && isSupported;
  const tts = useTextToSpeech();
  const coachSpeaking = tts.activeId === "idea-coach" && tts.state !== "idle";
  function dismissCoach() {
    tts.stop();
    onCoachDone?.();
  }

  // The one wiggle-only reminder: play the animation, then report it spent.
  const [nudging, setNudging] = useState(false);
  useEffect(() => {
    if (!nudge || !isSupported || coachActive) return;
    setNudging(true);
    const t = setTimeout(() => {
      setNudging(false);
      onNudgeShown?.();
    }, RENUDGE_ANIM_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge, isSupported, coachActive]);

  // Fatal mic error (permission/hardware): the hook already stopped listening —
  // fold it into the state machine so the error shows next to the tab.
  useEffect(() => {
    if (micError) setTab((t) => nextMicTabState(t, "fatalError"));
  }, [micError]);

  // Slid out but idle → tuck away again (harmless if listening; see machine).
  useEffect(() => {
    if (tab !== "out" || micError) return;
    const t = setTimeout(() => setTab((s) => nextMicTabState(s, "dismiss")), TAB_AUTO_TUCK_MS);
    return () => clearTimeout(t);
  }, [tab, micError]);

  // Quiet for a bit with words on screen → nudge toward ✅ (Composer pattern).
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    setIdle(false);
    if (tab !== "listening" || !display.trim()) return;
    const t = setTimeout(() => setIdle(true), NUDGE_MS);
    return () => clearTimeout(t);
  }, [tab, display]);

  // Leaving the preview (unmount) mid-capture: stop the mic, drop the draft.
  useEffect(() => () => discardAndStop(), [discardAndStop]);

  if (!isSupported) return null;

  function handleTabClick() {
    if (dragRef.current?.moved) return; // it was a drag, not a click
    // Using it IS learning it: a tab tap during the intro dismisses the coach
    // and goes STRAIGHT to listening (not just slide-out — the kid watched
    // the demo, don't make them click twice).
    const fromCoach = coachActive;
    if (fromCoach) dismissCoach();
    const next = fromCoach ? "listening" : nextMicTabState(tab, "tabClick");
    if (next === "listening" && tab !== "listening") {
      clearError();
      setDraft("");
      start();
    }
    setTab(next);
  }

  function finish(kind: "got" | "never") {
    const text = display.trim();
    // The interim already rode along in `display` — kill the session without
    // committing it (same reason as the composer's send-while-dictating).
    discardAndStop();
    setDraft("");
    if (kind === "got" && text) onIdea(text);
    setTab(nextMicTabState(tab, kind));
  }

  // Drag the tab up/down the edge with pointer events; a real click stays put.
  function onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    dragRef.current = { startY: e.clientY, startPct: topPct, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d) return;
    const parent = e.currentTarget.parentElement;
    const h = parent?.clientHeight ?? 0;
    if (!h) return;
    const deltaPct = ((e.clientY - d.startY) / h) * 100;
    if (Math.abs(e.clientY - d.startY) > 6) d.moved = true;
    if (d.moved) setTopPct(Math.min(80, Math.max(8, d.startPct + deltaPct)));
  }
  function onPointerUp() {
    // Keep `moved` for the click that fires right after pointerup.
    setTimeout(() => (dragRef.current = null), 0);
  }

  const listening = tab === "listening" && isListening;

  return (
    <>
      {/* The edge tab — half-tucked unless slid out or listening. */}
      <button
        type="button"
        onClick={handleTabClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        aria-label={
          tab === "tucked" ? "Tell me your idea" : tab === "out" ? "Start talking" : "Listening"
        }
        aria-pressed={listening}
        title="Tell me your idea!"
        style={{ top: `${topPct}%` }}
        className={`absolute right-0 flex min-h-[44px] touch-none items-center gap-1 rounded-l-kid border-2 border-r-0 border-white py-2 pl-3 pr-2 text-xl shadow-lg transition-transform ${
          coachActive || nudging ? "z-40 idea-coach-wiggle idea-coach-glow" : "z-20"
        } ${listening ? "mic-listening bg-danger-500 text-white" : "bg-brand-500 text-white"} ${
          tab === "tucked" && !coachActive && !nudging ? "translate-x-[45%]" : "translate-x-0"
        }`}
      >
        🎤
        {listening && <span className="text-[10px] font-extrabold">ON</span>}
      </button>

      {/* First-run coach overlay: dim + bubble + mini demo. Tap anywhere
          dismisses; the tab (z-40) stays clickable above the dim. */}
      {coachActive && (
        <div
          className="absolute inset-0 z-30 bg-ink-900/30"
          onClick={dismissCoach}
          role="dialog"
          aria-label="Meet the Idea Button"
        >
          <div
            className="idea-coach-pop absolute right-20 top-[16%] w-[min(320px,75%)] rounded-kid bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-base font-extrabold text-neutral-800">
              Hi! I&apos;m your Idea Button!
            </p>
            <p className="mt-1 text-sm leading-snug text-neutral-700">
              Tap me and <b>SAY</b> your idea — no typing! I&apos;ll keep it safe in your bag. 🎒
            </p>
            <div className="mt-3 flex min-h-[38px] items-center gap-2 rounded-xl bg-brand-50 px-3 py-2 text-sm font-bold text-neutral-800">
              <span className="mic-listening flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger-500 text-xs text-white" aria-hidden>
                🎤
              </span>
              <span className="idea-coach-type">&quot;make the dino purple!&quot;</span>
            </div>
            <span className="idea-coach-fly absolute -bottom-2 left-6 text-2xl" aria-hidden>💡</span>
            <div className="mt-3 flex gap-2">
              {/* Voice on request only (MessageItem's ReadAloudControls pattern). */}
              <button
                type="button"
                aria-label={coachSpeaking ? "Stop" : "Hear it"}
                onClick={() =>
                  coachSpeaking ? tts.stop() : tts.speak("idea-coach", COACH_LINE)
                }
                className="rounded-full bg-brand-50 px-4 py-2.5 text-sm font-extrabold text-brand-600 hover:bg-brand-100"
              >
                {coachSpeaking ? "⏹ Stop" : "🔊 Hear it"}
              </button>
              <button
                type="button"
                onClick={dismissCoach}
                className="flex-1 rounded-full bg-brand-500 px-4 py-2.5 text-sm font-extrabold text-white shadow-sm hover:bg-brand-600"
              >
                OK, got it! 👍
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Friendly mic error, next to the tab (grown-up help copy from mic-errors). */}
      {micError && tab !== "tucked" && (
        /* z-30: above the bag chip — while the bar/error owns the bottom edge
           the chip must not swallow taps on ✅ (caught in the visual pass). */
        <div className="absolute inset-x-3 bottom-3 z-30 flex items-center justify-between gap-2 rounded-kid border border-amber-200 bg-amber-50 px-4 py-2 shadow-lg">
          <span className="text-sm font-medium text-amber-800">{micError}</span>
          <button
            type="button"
            onClick={() => {
              clearError();
              setTab("tucked");
            }}
            aria-label="Dismiss"
            className="rounded-full px-2 text-amber-800 hover:bg-amber-100"
          >
            ✕
          </button>
        </div>
      )}

      {/* Listening bar along the preview bottom — the game keeps running above. */}
      {listening && (
        <div className="absolute inset-x-3 bottom-3 z-30 rounded-kid bg-white p-3 shadow-xl">
          <p className="flex items-center gap-2 text-sm font-extrabold text-neutral-800">
            <span className="mic-listening inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger-500 text-sm text-white" aria-hidden>
              🎤
            </span>
            {idle ? "All done? Tap ✅ Got it!" : "I'm listening! Tell me your idea — you can keep playing!"}
          </p>
          <p
            aria-live="polite"
            className="mt-2 min-h-[2.5rem] rounded-xl bg-brand-50 px-3 py-2 text-sm leading-snug text-neutral-800"
          >
            {draft}
            {interim && <span className="text-neutral-400"> {interim}</span>}
            {!display.trim() && <span className="text-neutral-400">…</span>}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => finish("got")}
              disabled={!display.trim()}
              className={`rounded-full bg-safe-500 px-4 py-2 text-sm font-extrabold text-white shadow-sm disabled:opacity-40 ${
                idle && display.trim() ? "animate-pulse" : ""
              }`}
            >
              ✅ Got it!
            </button>
            <button
              type="button"
              onClick={() => finish("never")}
              className="rounded-full bg-neutral-100 px-4 py-2 text-sm font-bold text-neutral-700 hover:bg-neutral-200"
            >
              🗑️ Never mind
            </button>
          </div>
        </div>
      )}
    </>
  );
}
