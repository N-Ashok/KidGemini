"use client";
// Speech-to-text hook using the browser Web Speech API. Single responsibility:
// turn microphone audio into text. No UI, no chat logic. See CLAUDE.md § 5 naming.
//
// Mobile hardening (BUG-FIX-LOG 2026-07-07):
//  - ONE recognizer for the hook's lifetime; the transcript callback lives in
//    a ref. The old effect depended on the callback prop (a fresh closure
//    every render), so the recognizer was torn down/recreated constantly —
//    iOS WebKit drops sessions when that happens mid-listen.
//  - Errors surface as a kid-friendly `error` message (they were swallowed,
//    so a denied mic permission looked like "nothing happened").
//  - Secure context required: WebKit blocks the mic on plain http (e.g. a
//    phone opening the dev server via a LAN IP) — treated as unsupported.
//
// Keep-alive (BUG-FIX-LOG 2026-07-09): the mic stays on until the kid stops it.
//  - `continuous = true` so a breath between sentences doesn't end the session.
//  - Browsers still end recognition on longer silence — `onend` silently
//    restarts while `wantListeningRef` is set. Only fatal errors (permission,
//    hardware, network — see isFatalMicError) or an explicit stop() end it.
//
// Interim flush (BUG-FIX-LOG 2026-07-10): browsers hard-end a session mid-
// speech and DISCARD everything recognized but not yet finalized — a long
// unbroken monologue could lose all but the last sentence. Interim results
// are now tracked (splitSpeechResults) and the pending tail is committed
// whenever the session ends (silence timeout, hard cap, or the kid's stop).
//
// Repeat-mic fix (BUG-FIX-LOG 2026-07-14): "I want" was arriving as "I want
// I want I want" (short phrase) or 30-40x on a longer monologue. Root cause:
// onresult trusted the browser's own `event.resultIndex` to know what's new
// since the last event; on some browsers/webviews that index doesn't advance
// reliably, so every newly-finalized segment replayed the WHOLE session's
// finals again. Fixed by self-tracking how many finals we've already
// committed (`committedFinalsRef`, reset at every rec.start()) instead of
// trusting resultIndex — see speech-transcript.ts for the slicing logic.
//
// Repeat-mic fix, take 2 (BUG-FIX-LOG 2026-07-16): the fix above still reset
// `committedFinalsRef` to 0 at every `rec.start()` CALL, not every successful
// start — but `start()` throws ("already started") when the browser hasn't
// actually torn down the previous session yet (a Chrome timing quirk; the
// restart delay is best-effort, not a guarantee). When that race hits, the
// OLD session — with its already-accumulated finals — keeps running, so
// zeroing the counter anyway made the next result replay everything already
// committed. `committedCountAfterRestart` only resets on a start() that
// actually succeeded.

import { useCallback, useEffect, useRef, useState } from "react";
import { isFatalMicError } from "@/lib/mic-errors";
import { micAskCoachCard, micRecoveryCard } from "@/lib/mic-recovery";
import { detectBrowser, detectPlatform, queryMicPermission, readPlatformSignals } from "@/lib/platform";
import { committedCountAfterRestart, splitSpeechResults } from "@/lib/speech-transcript";
import type { MicRecoveryCard } from "@/types/mic.types";

// Minimal typing for the non-standard SpeechRecognition API.
type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  /** Immediate stop that discards buffered audio (not on old WebKit). */
  abort?: () => void;
  onresult:
    | ((e: {
        resultIndex?: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};

// Gap before a silent restart — recognition must fully wind down first.
const RESTART_DELAY_MS = 200;

function getRecognition(): SpeechRecognition | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) return null; // http on a phone → mic is blocked anyway
  const Ctor =
    (window as unknown as { SpeechRecognition?: new () => SpeechRecognition })
      .SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition })
      .webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function useSpeechInput(onTranscript: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  // Device-aware recovery card (BUG-FIX-LOG 2026-07-20 "laptop told to fix
  // Siri") — a structured card, not a string, so the surface can render
  // steps + a Try again action instead of a dead-end sentence.
  const [error, setError] = useState<MicRecoveryCard | null>(null);
  // Live recognized-but-not-final speech, exposed so the composer can "type"
  // words as the kid says them. Committed via onTranscript when finalized.
  const [interim, setInterim] = useState("");
  const recRef = useRef<SpeechRecognition | null>(null);
  // True from start() until the kid (or a fatal error) stops it — onend
  // consults this to silently restart instead of ending the session.
  const wantListeningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Recognized-but-not-final speech; flushed on session end so it's never lost.
  const interimRef = useRef("");
  // How many finalized segments THIS session has already been committed to
  // onTranscript — self-tracked because the browser's own resultIndex can't
  // be trusted (see speech-transcript.ts, 2026-07-14 repeat-mic bug). Reset
  // to 0 at every rec.start() — a fresh session gets a fresh results list.
  const committedFinalsRef = useRef(0);
  // The actual TEXTS committed this listen (across silent restarts) — the
  // take-3 replay guard (speech-transcript.ts, 2026-07-18): counters reset on
  // a successful restart, but a lingering old session's stale list can then
  // resurface; matching texts catches what counting can't. Reset only on a
  // kid-initiated start().
  const committedTextsRef = useRef<string[]>([]);

  // Latest callback without retriggering the setup effect.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    if (recRef.current) return; // one recognizer for the hook's lifetime
    const rec = getRecognition();
    setIsSupported(Boolean(rec));
    if (!rec) return;
    rec.lang = "en-US";
    rec.continuous = true; // don't end the session at the first pause in speech
    rec.interimResults = true; // see interim-flush note above — finals alone lose long speech
    rec.onresult = (e) => {
      const { freshFinalText, freshSegments, interimText, finalCount } = splitSpeechResults(
        e.results,
        committedFinalsRef.current,
        committedTextsRef.current,
      );
      committedFinalsRef.current = finalCount;
      committedTextsRef.current.push(...freshSegments);
      // Committed as-is: Web Speech emits no punctuation, and heuristics only
      // punctuated pause boundaries (owner decision 2026-07-10: none at all
      // beats inconsistent — revisit with a server STT if UAT demands it).
      if (freshFinalText) onTranscriptRef.current(freshFinalText);
      // The not-yet-final tail: shown live in the composer, committed by
      // onend if the session dies first.
      interimRef.current = interimText;
      setInterim(interimText);
    };
    rec.onend = () => {
      // The session is over — whatever never finalized would be discarded by
      // the browser. Commit it so a hard-capped monologue keeps every word.
      if (interimRef.current) {
        onTranscriptRef.current(interimRef.current);
        // It just got committed like any final — the replay guard must know,
        // or a stale list re-delivering it as a REAL final slips past dedup.
        committedTextsRef.current.push(interimRef.current);
        interimRef.current = "";
      }
      setInterim("");
      // Browsers end recognition on longer silence even in continuous mode —
      // restart quietly while the kid still wants the mic on.
      if (!wantListeningRef.current) {
        setIsListening(false);
        return;
      }
      restartTimerRef.current = setTimeout(() => {
        if (!wantListeningRef.current) return;
        let started = true;
        try { rec.start(); } catch { started = false; /* old session still alive */ }
        committedFinalsRef.current = committedCountAfterRestart(started, committedFinalsRef.current);
      }, RESTART_DELAY_MS);
    };
    rec.onerror = (e) => {
      const code = e?.error ?? "";
      if (!isFatalMicError(code)) return; // pause in speech — onend restarts
      wantListeningRef.current = false;
      setIsListening(false);
      // Permission state distinguishes "kid dismissed the ask" (just re-ask)
      // from "saved block" (settings steps). The query is fast; failure is
      // "unknown" and falls through to the plainest card — never blocks.
      const signals = readPlatformSignals();
      void queryMicPermission().then((permission) => {
        setError(
          micRecoveryCard({
            code,
            platform: detectPlatform(signals),
            browser: detectBrowser(signals),
            permission,
          }),
        );
      });
    };
    recRef.current = rec;
  }, []);

  // Unmount: stop cleanly so a pending restart can't fire on a dead component.
  useEffect(() => () => {
    wantListeningRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    recRef.current?.stop();
  }, []);

  // The actual session start — shared by start(), the coach's "Okay, ask
  // me!" and every card's Try again.
  const beginListening = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    setError(null);
    committedTextsRef.current = []; // fresh listen — the replay guard starts clean
    wantListeningRef.current = true;
    let started = true;
    try { rec.start(); } catch { started = false; /* old session still alive */ }
    committedFinalsRef.current = committedCountAfterRestart(started, committedFinalsRef.current);
    if (started) setIsListening(true);
  }, []);

  // Pre-ask coach (wireframe A): the FIRST mic tap while the browser hasn't
  // been answered yet ("prompt") shows a friendly heads-up so the permission
  // dialog is expected — kids reflexively dismiss surprise popups, and on
  // Chrome repeated dismissals escalate to a saved block. Intercepts at most
  // once per mount; granted/denied/unknown all skip straight to listening.
  const coachCheckedRef = useRef(false);

  const start = useCallback(() => {
    if (!recRef.current) return;
    if (!coachCheckedRef.current) {
      coachCheckedRef.current = true;
      void queryMicPermission().then((state) => {
        if (state === "prompt") setError(micAskCoachCard(detectPlatform(readPlatformSignals())));
        else beginListening();
      });
      return;
    }
    beginListening();
  }, [beginListening]);

  /** Card primary action: clears the card and starts listening — if the fix
   *  worked the mic just turns on; if not, the (re-queried) card returns. */
  const tryAgain = useCallback(() => {
    setError(null);
    beginListening();
  }, [beginListening]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    recRef.current?.stop();
    setIsListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (isListening) stop();
    else start();
  }, [isListening, start, stop]);

  // Send-while-dictating: the composer has already TAKEN the interim text
  // (composeDictation), so kill the session without committing anything —
  // otherwise onend's flush (or a late final) would re-append it as a stray
  // draft after the send cleared the box. abort() discards buffered audio;
  // stop() is the fallback where abort doesn't exist.
  const discardAndStop = useCallback(() => {
    wantListeningRef.current = false;
    interimRef.current = "";
    setInterim("");
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    const rec = recRef.current;
    try {
      if (rec?.abort) rec.abort();
      else rec?.stop();
    } catch {
      /* not running */
    }
    setIsListening(false);
  }, []);

  return {
    isListening,
    isSupported,
    error,
    interim,
    clearError: () => setError(null),
    tryAgain,
    toggle,
    start,
    stop,
    discardAndStop,
  };
}
