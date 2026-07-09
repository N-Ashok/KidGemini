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

import { useCallback, useEffect, useRef, useState } from "react";
import { isFatalMicError, micErrorMessage } from "@/lib/mic-errors";

// Minimal typing for the non-standard SpeechRecognition API.
type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult:
    | ((e: { resultIndex?: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
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
  const recRef = useRef<SpeechRecognition | null>(null);
  // True from start() until the kid (or a fatal error) stops it — onend
  // consults this to silently restart instead of ending the session.
  const wantListeningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    rec.interimResults = false;
    rec.onresult = (e) => {
      // continuous mode accumulates results — only read the NEW ones, or every
      // restart/final would re-append everything said so far.
      const fresh = Array.from(e.results).slice(e.resultIndex ?? 0);
      const text = fresh
        .map((r) => r[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (text) onTranscriptRef.current(text);
    };
    rec.onend = () => {
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

  return { isListening, isSupported, error, clearError: () => setError(null), toggle, start, stop };
}
