"use client";
// Parent dashboard — per-family PIN (PRD-PARENT-AUTH-ALERT-SCOPING Phase 1).
// Flow: live parent session → alerts; otherwise verify the 4-digit PIN
// (POST body, throttled server-side); first visit → set-PIN interstitial,
// which requires a FRESH SSO login (the kid holding a parent's old session
// can't set it). Guests see sign-up copy, never a PIN form (D3).

import { useCallback, useEffect, useState } from "react";
import { signIn, useSession } from "@/lib/useAriantraSession";
import type { ParentAlert } from "@/types/alert.types";

interface FamilyGame {
  slug: string;
  name: string;
  status: string;
  multiplayer?: boolean;
}

// Family-profile signpost (owner decision 2026-07-13): the profile form lives
// in ONE place — the Studio's Creator Profile card — and this page only links
// to it (?profile=1 opens the card directly; SSO means no re-login).
const DEV = process.env.NODE_ENV !== "production";
const FAMILY_PROFILE_URL = DEV
  ? "http://localhost:3000/studio?profile=1"
  : "https://studio.ariantra.com/studio?profile=1";

type View =
  | { kind: "loading" }
  | { kind: "verify" }
  | { kind: "set" }
  | { kind: "signed-out" }
  | { kind: "alerts"; alerts: ParentAlert[] };

export default function ParentPage() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState("");
  // Multiplayer toggle (PRD-MULTIPLAYER.md Phase 4) — null = not fetched yet.
  const [games, setGames] = useState<FamilyGame[] | null>(null);
  const [togglingSlug, setTogglingSlug] = useState<string | null>(null);

  const loadAlerts = useCallback(async (): Promise<boolean> => {
    const res = await fetch("/api/alerts");
    if (!res.ok) return false;
    const data = (await res.json()) as { alerts: ParentAlert[] };
    setView({ kind: "alerts", alerts: data.alerts });
    return true;
  }, []);

  const loadGames = useCallback(async () => {
    const res = await fetch("/api/parent/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: true }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { games?: FamilyGame[] };
    setGames(data.games ?? []);
  }, []);

  const toggleMultiplayer = useCallback(async (slug: string, next: boolean) => {
    setTogglingSlug(slug);
    setGames((gs) => gs && gs.map((g) => (g.slug === slug ? { ...g, multiplayer: next } : g))); // optimistic
    try {
      const res = await fetch("/api/parent/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toggleMultiplayer: true, slug, multiplayer: next }),
      });
      if (!res.ok) {
        // Revert on failure — a silent toggle that doesn't stick is worse
        // than an obvious one that snaps back.
        setGames((gs) => gs && gs.map((g) => (g.slug === slug ? { ...g, multiplayer: !next } : g)));
      }
    } catch {
      setGames((gs) => gs && gs.map((g) => (g.slug === slug ? { ...g, multiplayer: !next } : g)));
    } finally {
      setTogglingSlug(null);
    }
  }, []);

  // Guests never see a PIN form (D3) — sign-up copy instead. A signed-in
  // parent with a live parent session (last 30 min) skips the PIN entirely.
  const session = useSession();
  useEffect(() => {
    if (session.status === "loading") return;
    if (session.status === "unauthenticated") {
      setView({ kind: "signed-out" });
      return;
    }
    void (async () => {
      if (await loadAlerts()) void loadGames();
      else setView({ kind: "verify" });
    })();
  }, [session.status, loadAlerts, loadGames]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/parent/verify-pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    setPin("");
    if (res.ok) {
      await loadAlerts();
      void loadGames();
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      attemptsLeft?: number;
      unlockAt?: number;
    };
    if (res.status === 401 && data.error === "signed_out") { setView({ kind: "signed-out" }); return; }
    if (res.status === 404) { setView({ kind: "set" }); return; }
    if (res.status === 429) {
      const at = data.unlockAt ? new Date(data.unlockAt).toLocaleTimeString() : "later";
      setError(`Too many tries — locked until ${at}.`);
      return;
    }
    setError(
      `Wrong PIN${typeof data.attemptsLeft === "number" ? ` — ${data.attemptsLeft} tries left` : ""}.`,
    );
  }

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (pin !== pin2) {
      setError("Those don't match — type the same 4 digits twice.");
      return;
    }
    const res = await fetch("/api/parent/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (res.ok) {
      setPin("");
      setPin2("");
      await loadAlerts();
      void loadGames();
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.status === 401) { setView({ kind: "signed-out" }); return; }
    if (res.status === 403 && data.error === "stale_session") {
      setError("For safety, sign in again first — then come straight back here.");
      return;
    }
    setError(data.message ?? "That PIN won't work — pick 4 digits that aren't an easy pattern.");
  }

  const pinInput = (value: string, set: (v: string) => void, placeholder: string, autoFocus = false) => (
    <input
      autoFocus={autoFocus}
      type="password"
      inputMode="numeric"
      maxLength={4}
      value={value}
      onChange={(e) => set(e.target.value.replace(/\D/g, ""))}
      placeholder={placeholder}
      className="w-full rounded-kid border-2 border-brand-100 px-4 py-3 text-center text-xl font-bold tracking-[0.5em] outline-none focus:border-brand-500"
    />
  );

  const accent: Record<string, string> = {
    high: "border-danger-500",
    medium: "border-warn-500",
    low: "border-brand-300",
  };

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 font-display text-3xl font-bold text-ink-900">Parent area</h1>

      {view.kind === "loading" && (
        <div className="card max-w-sm animate-pulse space-y-3">
          <div className="h-5 w-2/3 rounded bg-neutral-200" />
          <div className="h-12 rounded-kid bg-neutral-100" />
        </div>
      )}

      {view.kind === "signed-out" && (
        <div className="card max-w-sm space-y-4 text-center">
          <div className="text-4xl" aria-hidden>🛡️</div>
          <h2 className="text-lg font-semibold">The parent area needs a family account</h2>
          <p className="text-sm text-ink-700">
            Sign in (or make a free account) and you&rsquo;ll see your child&rsquo;s safety alerts
            here — plus you&rsquo;ll set the parent PIN that approves publishing games.
          </p>
          <button onClick={() => signIn()} className="btn-primary w-full">
            Sign in to Ariantra
          </button>
        </div>
      )}

      {view.kind === "verify" && (
        <form onSubmit={handleVerify} className="card max-w-sm space-y-4">
          <label className="block text-lg font-semibold">Enter your parent PIN</label>
          {pinInput(pin, setPin, "••••", true)}
          {error && <p className="text-sm font-medium text-danger-600">{error}</p>}
          <button disabled={pin.length !== 4} className="btn-primary w-full disabled:opacity-40">
            Unlock
          </button>
          <button
            type="button"
            onClick={() => { setError(""); setView({ kind: "set" }); }}
            className="w-full text-sm text-brand-600 hover:underline"
          >
            First time here? Set your PIN →
          </button>
        </form>
      )}

      {view.kind === "set" && (
        <form onSubmit={handleSet} className="card max-w-sm space-y-4">
          <label className="block text-lg font-semibold">Set your family&rsquo;s parent PIN</label>
          <p className="text-sm text-ink-700">
            4 digits. You&rsquo;ll use it to open this page and to approve putting games on the
            internet. For safety this only works right after signing in — if it complains, sign
            in again first.
          </p>
          {pinInput(pin, setPin, "New PIN", true)}
          {pinInput(pin2, setPin2, "Same PIN again")}
          {error && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-danger-600">{error}</p>
              {error.includes("sign in again") && (
                // reauth: a plain signIn() bounces straight back with the SAME
                // old cookie (SSO short-circuit) and this error never clears.
                <button type="button" onClick={() => signIn({ reauth: true })} className="btn-primary w-full">
                  Sign in again
                </button>
              )}
            </div>
          )}
          <button
            disabled={pin.length !== 4 || pin2.length !== 4}
            className="btn-primary w-full disabled:opacity-40"
          >
            Save PIN
          </button>
        </form>
      )}

      {view.kind === "alerts" && (
        <section className="space-y-3">
          <article className="card flex flex-wrap items-center justify-between gap-4 border-l-4 border-brand-300">
            <div>
              <h2 className="text-lg font-semibold">👨‍👩‍👧 Your family profile</h2>
              <p className="mt-1 text-sm text-ink-700">
                Add a parent&rsquo;s contact details (stored encrypted, never shown to anyone) so we
                can reach you about your child&rsquo;s games — it&rsquo;s also needed before a game
                can be published.
              </p>
            </div>
            <a href={FAMILY_PROFILE_URL} className="btn-primary whitespace-nowrap">
              Open family profile →
            </a>
          </article>

          {games && games.length > 0 && (
            <article className="card space-y-3 border-l-4 border-brand-300">
              <div>
                <h2 className="text-lg font-semibold">🎮 Multiplayer</h2>
                <p className="mt-1 text-sm text-ink-700">
                  Turn "Play together" on or off for each of your child&rsquo;s published games.
                  Off means friends can&rsquo;t invite each other into a live game.
                </p>
              </div>
              <ul className="divide-y divide-neutral-100">
                {games.map((g) => (
                  <li key={g.slug} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink-900">{g.name}</div>
                      <div className="truncate text-xs text-ink-500">{g.slug}.ariantra.com · {g.status}</div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={g.multiplayer === true}
                      aria-label={`Multiplayer for ${g.name}`}
                      disabled={togglingSlug === g.slug}
                      onClick={() => void toggleMultiplayer(g.slug, !g.multiplayer)}
                      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                        g.multiplayer ? "bg-brand-500" : "bg-neutral-300"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                          g.multiplayer ? "translate-x-5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          )}

          <h2 className="text-xl font-semibold">Safety alerts ({view.alerts.length})</h2>
          {view.alerts.length === 0 && <p className="text-ink-500">No alerts yet. 🎉</p>}
          {view.alerts.map((a) => (
            <article
              key={a.id}
              className={`card border-l-4 ${accent[a.severity] ?? "border-brand-300"}`}
            >
              <div className="flex items-center justify-between text-sm text-ink-500">
                <span>
                  {a.severity.toUpperCase()} · {a.category ?? "general"} · from {a.origin}
                </span>
                <time>{new Date(a.createdAt).toLocaleString()}</time>
              </div>
              <p className="mt-2 font-medium text-ink-900">“{a.triggerText}”</p>
              <p className="mt-1 text-ink-700">{a.reason}</p>
              <p className="mt-1 text-sm text-ink-500">Action: {a.action}</p>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
