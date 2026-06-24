"use client";
// Read-aloud via the browser SpeechSynthesis API. Single responsibility: speak text
// with play / pause / resume / stop / restart. Tracks which message is active so the UI
// can show controls on the right bubble. No chat logic.

import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechState = "idle" | "speaking" | "paused";

export function useTextToSpeech() {
  const [state, setState] = useState<SpeechState>("idle");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(false);
  const lastRef = useRef<{ id: string; text: string } | null>(null);

  useEffect(() => {
    setIsSupported(typeof window !== "undefined" && "speechSynthesis" in window);
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const speak = useCallback((id: string, text: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1.05; // a touch warmer for kids
    u.onend = () => {
      setState("idle");
      setActiveId(null);
    };
    u.onerror = () => {
      setState("idle");
      setActiveId(null);
    };
    lastRef.current = { id, text };
    setActiveId(id);
    setState("speaking");
    window.speechSynthesis.speak(u);
  }, []);

  const pause = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.pause();
    setState("paused");
  }, []);

  const resume = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.resume();
    setState("speaking");
  }, []);

  const stop = useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setState("idle");
    setActiveId(null);
  }, []);

  const restart = useCallback(() => {
    const last = lastRef.current;
    if (last) speak(last.id, last.text);
  }, [speak]);

  return { state, activeId, isSupported, speak, pause, resume, stop, restart };
}
