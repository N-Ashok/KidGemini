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

import { useCallback, useEffect, useRef, useState } from "react";
import { isFatalMicError, micErrorMessage } from "@/lib/mic-errors";
import { splitSpeechResults } from "@/lib/speech-transcript";

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
  const [error, setError] = useState<string | null>(null);
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
      const { freshFinalText, interimText } = splitSpeechResults(e.results, e.resultIndex);
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
        try { rec.start(); } catch { /* already started */ }
      }, RESTART_DELAY_MS);
    };
    rec.onerror = (e) => {
      const code = e?.error ?? "";
      if (!isFatalMicError(code)) return; // pause in speech — onend restarts
      wantListeningRef.current = false;
      setError(micErrorMessage(code));
      setIsListening(false);
    };
    recRef.current = rec;
  }, []);

  // Unmount: stop cleanly so a pending restart can't fire on a dead component.
  useEffect(() => () => {
    wantListeningRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    setError(null);
    wantListeningRef.current = true;
    try { rec.start(); setIsListening(true); } catch { /* already started */ }
  }, []);

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
    toggle,
    start,
    stop,
    discardAndStop,
  };
}
