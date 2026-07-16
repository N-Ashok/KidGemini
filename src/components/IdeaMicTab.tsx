"use client";
// The Idea Button (docs/PRD-IDEA-BUTTON.md): an edge-docked mic tab over the
// game preview so a kid who can't type can speak thoughts WHILE playing.
// Docked near the TOP of the preview edge, still draggable if a game's own
// HUD needs that corner instead.
//
// Compact redesign (2026-07-16): the original always-visible label sat
// BESIDE the 🎤 emoji, which made the resting tab a wide pill — flagged as
// "odd/ugly." The 2026-07-14 fix's actual point still holds (a hover-only
// tooltip is invisible on touch — see that BUG-FIX-LOG entry) — so the label
// isn't removed, just moved BELOW a compact 44×44 circular icon as a small
// standalone caption, like an app-dock label: always visible (still
// touch-discoverable), but no longer widens the tappable button itself.
//
// Capture ≠ send: ✅ hands the transcript to the container's Idea Bag — no
// network, no generation, back to the game in seconds. Presentational; the
// tab state machine lives in lib/idea-mic.ts, speech in useSpeechInput.

import { useEffect, useRef, useState } from "react";
import { composeDictation } from "@/lib/speech-transcript";
import { nextMicTabState, TAB_AUTO_TUCK_MS, type MicTabState } from "@/lib/idea-mic";
import { COACH_LINE } from "@/lib/idea-coach";
import { useSpeechInput } from "./useSpeechInput";
import { useTextToSpeech } from "./useTextToSpeech";
import type { BagIdea } from "./IdeaBag";

interface IdeaMicTabProps {
  /** ✅ Got it! — the finished transcript, ready for the bag. */
  onIdea: (text: string) => void;
  /** Already-bagged ideas (2026-07-15) — shown as a compact list while
   *  listening, so a kid mid-capture can see what they've already said
   *  without leaving this bar to open the separate Idea Bag panel. */
  ideas?: BagIdea[];
  /** ✨ Make my game better! (2026-07-16) — the SAME bundle-send the Idea Bag
   *  panel's own button calls; offered here too so finishing a thought and
   *  sending it don't require a separate trip through the bag chip. Absent
   *  prop = hidden, matching the rest of this file's optional-prop pattern. */
  onMakeBetter?: () => void;
  /** A generation is already streaming — mirrors IdeaBag's own CTA disable. */
  busy?: boolean;
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

export function IdeaMicTab({ onIdea, ideas, onMakeBetter, busy, coach, onCoachDone, nudge, onNudgeShown }: IdeaMicTabProps) {
  const [tab, setTab] = useState<MicTabState>("tucked");
  // Committed (finalized) speech for the CURRENT capture; interim rides on top.
  const [draft, setDraft] = useState("");
  // Vertical position of the tab along the preview edge (% of height) — docked
  // near the top by default (visible, out of the way of bottom/center HUD
  // controls) but still draggable if a game puts something there instead.
  const [topPct, setTopPct] = useState(8);
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

  function finish(kind: "got" | "done" | "never") {
    const text = display.trim();
    if (kind === "got") {
      // "Next idea" (2026-07-14, relabeled from "Got it!" — that name was
      // misleading once it stopped closing anything): commit and keep
      // listening, so a kid with several ideas doesn't have to re-tap the
      // tab between each one. Only the LOCAL draft resets; the mic session
      // itself keeps running uninterrupted, so the next idea starts from a
      // clean slate without a stop+restart (that race is exactly what the
      // repeat-mic fix elsewhere guards against — no reason to reintroduce
      // it here).
      if (text) onIdea(text);
      setDraft("");
      setTab(nextMicTabState(tab, "got"));
      return;
    }
    // "Done" (commit the last idea, then close) and "Never mind" (discard
    // without committing, then close) both end the session — the explicit
    // way back to tucked now that "Next idea" no longer does that.
    if (kind === "done" && text) onIdea(text);
    discardAndStop();
    setDraft("");
    setTab(nextMicTabState(tab, "never"));
  }

  // ✨ Make my game better! reached directly from mid-capture (2026-07-16):
  // commit whatever's on screen (same as "Done"), close the session the same
  // way, THEN hand off to the container's real send — no detour through the
  // separate Idea Bag panel to find this button.
  function handleMakeBetterFromMic() {
    const text = display.trim();
    if (text) onIdea(text);
    discardAndStop();
    setDraft("");
    setTab(nextMicTabState(tab, "never"));
    onMakeBetter?.();
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
      {/* The tab: a compact, FLOATING circular icon (2026-07-16 — see file
          header) with a small margin off the edge (not flush against it —
          a flush, rounded-one-side shape read as a stray "growth" on the
          edge, not a self-contained button) and an always-visible caption
          BELOW it, not beside it, so the label stays discoverable without
          widening the tappable button. */}
      <div
        style={{ top: `${topPct}%` }}
        className={`absolute right-3 flex flex-col items-center gap-1 ${
          coachActive || nudging ? "z-40" : "z-20"
        }`}
      >
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
          className={`flex h-12 w-12 touch-none items-center justify-center rounded-full border-2 border-white text-xl shadow-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-300 focus-visible:ring-offset-2 ${
            coachActive || nudging ? "idea-coach-wiggle idea-coach-glow" : ""
          } ${listening ? "mic-listening bg-danger-500 text-white" : "bg-brand-500 text-white hover:bg-brand-600"}`}
        >
          🎤
        </button>
        {/* Always-visible caption (BUG-FIX-LOG 2026-07-14: a hover-only title
            never reached kids on touch devices) — a small dock-style label
            under the icon instead of beside it. */}
        <span
          aria-hidden
          className="rounded-full bg-white px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-neutral-500 shadow-sm"
        >
          {listening ? "On" : "Idea"}
        </span>
      </div>

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
            className="idea-coach-pop absolute right-16 top-[16%] w-[min(320px,75%)] rounded-kid bg-white p-4 shadow-lg"
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
        <div className="absolute inset-x-3 bottom-3 z-30 flex items-center justify-between gap-2 rounded-kid border border-amber-200 bg-amber-50 px-4 py-2 shadow-md">
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
        <div className="absolute inset-x-3 bottom-3 z-30 mx-auto max-w-md rounded-kid bg-white p-4 shadow-lg">
          {/* Corner close (2026-07-15): the standard "just close this" spot —
              same as Never mind (discard the CURRENT draft only; anything
              already in the bag stays put), offered as its own affordance
              since a kid reaching for a corner X shouldn't have to parse
              Next/Done/Never mind first. */}
          <button
            type="button"
            onClick={() => finish("never")}
            aria-label="Close"
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            ✕
          </button>
          <p className="flex items-center gap-2 pr-8 text-sm font-extrabold text-neutral-800">
            <span className="mic-listening inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger-500 text-sm text-white" aria-hidden>
              🎤
            </span>
            {idle ? "All done? Tap ➡️ Next idea, or 🏁 Done" : "I'm listening! Tell me your idea — you can keep playing!"}
          </p>
          {/* Already-saved ideas (2026-07-15): a kid mid-capture could only
              see this list by leaving the bar and opening the separate Idea
              Bag chip — surfaced here too, compact and scrollable, so "what
              have I already said?" doesn't need a detour. */}
          {ideas && ideas.length > 0 && (
            <div className="mt-2 max-h-16 overflow-y-auto rounded-lg bg-brand-50/60 px-2 py-1">
              <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-400">
                🎒 Saved so far ({ideas.length})
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {ideas.map((idea) => (
                  <li key={idea.id} className="truncate text-xs text-neutral-600">
                    • {idea.text}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Editable (2026-07-14): a kid can tap in and fix a minor spelling
              mistake with the keyboard instead of re-saying the whole idea.
              Bound to `draft` only — new speech still appends onto whatever's
              here, edited or not. `interim` (live, not-yet-final recognition)
              shows as a non-editable trailing hint since it's about to be
              overwritten by the recognizer anyway. */}
          <textarea
            aria-label="Your idea — tap to fix a typo"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="…"
            rows={2}
            className="mt-2 w-full resize-none rounded-xl bg-brand-50 px-3 py-2 text-sm leading-snug text-neutral-800 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-brand-500"
          />
          {interim && (
            <p aria-live="polite" className="mt-1 px-1 text-xs text-neutral-400">
              {interim}
            </p>
          )}
          {/* ✨ Make my game better!, reachable directly from mid-capture
              (2026-07-16) — same bundle-send the Idea Bag panel's own button
              triggers, offered here too so finishing a thought and sending it
              don't require a separate trip through the 🎒 chip. Only shown
              when there's something to send (the current draft, or anything
              already bagged) and the caller wired it up at all. */}
          {onMakeBetter && (display.trim() || (ideas && ideas.length > 0)) && (
            <button
              type="button"
              onClick={handleMakeBetterFromMic}
              disabled={busy}
              className="mt-2 w-full rounded-full bg-brand-500 px-4 py-2.5 text-sm font-extrabold text-white shadow-md shadow-brand-500/20 hover:bg-brand-600 disabled:opacity-40"
            >
              {busy ? "🛠️ Still building the last one…" : "✨ Make my game better!"}
            </button>
          )}
          <div className="mt-2 flex gap-2">
            {/* Next idea (2026-07-14, renamed from "Got it!" — that name was
                misleading once it stopped closing anything): commits and
                keeps listening. "Done" is the explicit close — commits
                whatever's here (if anything) THEN tucks away, so ending the
                session no longer requires discarding through Never mind.
                Icon changed from ✕ to 🏁 (2026-07-15) — an X read as
                "cancel/discard," the opposite of what finishing successfully
                means; ✕ is now reserved for the corner Close and Never mind. */}
            {/* Soft brand style (2026-07-16, was bg-safe-500/green): two
                differently-hued solid pills side by side read as busy/
                uncoordinated, and DESIGN_SYSTEM.md reserves safe/danger/warn
                for actual STATUS signaling, not general button decoration.
                One brand hue at two weights (soft here, solid on Done) reads
                as a cleaner primary/secondary pair. */}
            <button
              type="button"
              onClick={() => finish("got")}
              disabled={!display.trim()}
              className={`flex-1 rounded-full bg-brand-50 px-4 py-2 text-sm font-extrabold text-brand-700 disabled:opacity-40 ${
                idle && display.trim() ? "animate-pulse" : "hover:bg-brand-100"
              }`}
            >
              ➡️ Next idea
            </button>
            <button
              type="button"
              onClick={() => finish("done")}
              className="flex-1 rounded-full bg-brand-500 px-4 py-2 text-sm font-extrabold text-white shadow-sm hover:bg-brand-600"
            >
              🏁 Done
            </button>
          </div>
          <button
            type="button"
            onClick={() => finish("never")}
            className="mt-1.5 w-full rounded-full px-4 py-1.5 text-xs font-bold text-neutral-500 hover:bg-neutral-100"
          >
            🗑️ Never mind
          </button>
        </div>
      )}
    </>
  );
}
