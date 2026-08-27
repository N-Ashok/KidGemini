"use client";
// Live Sparks balance for the header + mobile tab (docs/2026-08-27_PRD_SparksPage.md
// §2b — owner 2026-08-27: chat window AND Sparks page both show it). Source of
// truth is the platform ledger: fetched once on sign-in via /api/sparks/usage,
// then kept current by the chat panel, which broadcasts the balance riding each
// turn's `sparks` frame — no second fetch per turn. `null` = not known yet
// (render a loading state, never a blank).
import { useEffect, useState } from "react";

export const SPARKS_BALANCE_EVENT = "ariantra:sparks-balance";

export function publishSparksBalance(balance: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SPARKS_BALANCE_EVENT, { detail: { balance } }));
}

export function useSparksBalance(enabled: boolean): number | null {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/api/sparks/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { balance?: unknown } | null) => {
        if (alive && d && typeof d.balance === "number") setBalance(d.balance);
      })
      .catch(() => { /* header stays in its loading state; the next turn's receipt fills it */ });
    const onEvent = (e: Event) => {
      const b = (e as CustomEvent<{ balance?: unknown }>).detail?.balance;
      if (typeof b === "number") setBalance(b);
    };
    window.addEventListener(SPARKS_BALANCE_EVENT, onEvent);
    return () => { alive = false; window.removeEventListener(SPARKS_BALANCE_EVENT, onEvent); };
  }, [enabled]);
  return balance;
}
