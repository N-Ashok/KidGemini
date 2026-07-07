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

import { useCallback, useEffect, useRef, useState } from "react";
import { micErrorMessage } from "@/lib/mic-errors";

// Minimal typing for the non-standard SpeechRecognition API.
type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};

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

  // Latest callback without retriggering the setup effect.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    if (recRef.current) return; // one recognizer for the hook's lifetime
    const rec = getRecognition();
    setIsSupported(Boolean(rec));
    if (!rec) return;
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map((r) => r[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (text) onTranscriptRef.current(text);
    };
    rec.onend = () => setIsListening(false);
    rec.onerror = (e) => {
      setError(micErrorMessage(e?.error ?? ""));
      setIsListening(false);
    };
    recRef.current = rec;
  }, []);

  const start = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    setError(null);
    try { rec.start(); setIsListening(true); } catch { /* already started */ }
  }, []);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setIsListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (isListening) stop();
    else start();
  }, [isListening, start, stop]);

  return { isListening, isSupported, error, clearError: () => setError(null), toggle, start, stop };
}
