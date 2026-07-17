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
const STUDIO_BASE = DEV ? "http://localhost:3000" : "https://studio.ariantra.com";
// 2026-07-15: carries profileReturnTo so Studio can bounce back here after
// save/close instead of stranding the parent on the bare Studio dashboard.
// Deliberately NOT named `returnTo` — that param already has an established,
// different meaning on the Studio page (resolveStudioArrival: an already
// signed-in visitor with ?returnTo= bounces immediately, before ever seeing
// the page — reusing the name caused exactly that, the profile card never
// rendered at all). safeReturnTo-validated the same way `returnTo` is.
// games-lab.ariantra.com is the canonical host (2026-07-17, later same day)
// — supersedes ari.ariantra.com; already allowlisted in the platform's
// safeReturnTo (src/lib/auth/return-to.ts's PLATFORM_HOST_RE).
const ARI_PARENT_URL = DEV ? "http://localhost:3001/parent" : "https://games-lab.ariantra.com/parent";
const FAMILY_PROFILE_URL = `${STUDIO_BASE}/studio?profile=1&profileReturnTo=${encodeURIComponent(ARI_PARENT_URL)}`;

// WhatsApp deep link (2026-07-17): try the installed app directly — mobile
// app or WhatsApp Desktop — via its `whatsapp://` URI scheme, which hands
// off to the app straight away, skipping wa.me's web landing page (the
// "select WhatsApp Web" intermediate step this replaces). Falls back to
// wa.me only if nothing takes over the page within ~1.2s, i.e. no app was
// there to catch the custom scheme. Kept in sync by hand with the
// equivalent function in Ariantra-Platform's CatalogClient.tsx /
// share-overlay.ts and this repo's PublishToArcade.tsx.
function openWhatsApp(text: string) {
  const appUrl = `whatsapp://send?text=${encodeURIComponent(text)}`;
  const webUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const fallback = window.setTimeout(() => {
    window.open(webUrl, "_blank", "noopener,noreferrer");
  }, 1200);
  const cancel = () => window.clearTimeout(fallback);
  window.addEventListener("blur", cancel, { once: true });
  const onVisibility = () => {
    if (document.hidden) { cancel(); document.removeEventListener("visibilitychange", onVisibility); }
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.location.href = appUrl;
}

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
  // Sharing & Privacy is ONE setting per account (PRD-SHARING §9, set in the
  // family profile) — applies to every game in the list, not per-game. null
  // = not fetched yet, same "stays hidden until it loads" rule as screenTime.
  const [shareEnabled, setShareEnabled] = useState<boolean | null>(null);
  const [shareCredit, setShareCredit] = useState<{ name?: string; age?: number; place?: string } | null>(null);
  const [shareOpenSlug, setShareOpenSlug] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState("");
  const [shareConfirmedSlug, setShareConfirmedSlug] = useState<string | null>(null);
  // Daily screen-time cap (PRD-SCREEN-TIME-CAP-MVP Part B). null = not
  // fetched yet — the card stays hidden until it loads (no blank flash).
  const [screenTime, setScreenTime] = useState<{ dailyCapMinutes: number | null; todayActiveMinutes: number } | null>(null);
  const [capInput, setCapInput] = useState("");
  const [capSaving, setCapSaving] = useState(false);
  const [capError, setCapError] = useState("");
  // Explicit confirmation after Save (2026-07-15 UAT: a silent success left
  // the parent with no idea it worked) — clears the moment they edit again,
  // so it can never lie about an unsaved change.
  const [capSaved, setCapSaved] = useState(false);

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
    const data = (await res.json()) as {
      games?: FamilyGame[];
      shareEnabled?: boolean;
      credit?: { name?: string; age?: number; place?: string } | null;
    };
    setGames(data.games ?? []);
    setShareEnabled(data.shareEnabled === true);
    setShareCredit(data.credit ?? null);
  }, []);

  function openShare(g: FamilyGame) {
    const url = `https://${g.slug}.ariantra.com/`;
    // Copy rewrite (2026-07-17): the kid is the hook, not the platform — a
    // named "a 10-year-old made this" beats any platform tagline, and "no
    // download" removes WhatsApp's one real objection. Brand tagline lives
    // in the game's OG description (platform's seo.ts), not repeated here.
    // No non-BMP emoji (🎮/👾/etc.) in message text — wa.me's own redirect
    // to api.whatsapp.com corrupts them into the UTF-8 replacement
    // character, verified independently of our code via a raw wa.me request.
    setShareMessage(
      shareCredit?.name
        ? `${shareCredit.name}${shareCredit.age ? `, ${shareCredit.age},` : ""} made a game. Actual playable game, in the browser, no download.\n${url}`
        : `My kid made a game! Actual playable game, in the browser, no download.\n${url}`,
    );
    setShareConfirmedSlug(null);
    setShareOpenSlug((s) => (s === g.slug ? null : g.slug));
  }

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

  const loadScreenTime = useCallback(async () => {
    const res = await fetch("/api/parent/screen-time");
    if (!res.ok) return;
    const data = (await res.json()) as { dailyCapMinutes: number | null; todayActiveMinutes: number };
    setScreenTime({ dailyCapMinutes: data.dailyCapMinutes, todayActiveMinutes: data.todayActiveMinutes });
    setCapInput(data.dailyCapMinutes != null ? String(data.dailyCapMinutes) : "");
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
      if (!(await loadAlerts())) { setView({ kind: "verify" }); return; }
      void loadGames();
      void loadScreenTime();
    })();
  }, [session.status, loadAlerts, loadGames, loadScreenTime]);

  async function saveScreenTimeCap(e: React.FormEvent) {
    e.preventDefault();
    setCapError("");
    setCapSaved(false);
    setCapSaving(true);
    try {
      const dailyCapMinutes = capInput.trim() === "" ? null : Number(capInput);
      const res = await fetch("/api/parent/screen-time", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dailyCapMinutes }),
      });
      if (res.ok) {
        const data = (await res.json()) as { dailyCapMinutes: number | null; todayActiveMinutes: number };
        setScreenTime({ dailyCapMinutes: data.dailyCapMinutes, todayActiveMinutes: data.todayActiveMinutes });
        setCapSaved(true);
        return;
      }
      if (res.status === 401) { setView({ kind: "signed-out" }); return; }
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      setCapError(data.message ?? "That didn't work — try a number between 1 and 1440, or clear it.");
    } finally {
      setCapSaving(false);
    }
  }

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
      void loadScreenTime();
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
      void loadScreenTime();
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
                can be published. The same page has <strong>Sharing &amp; privacy</strong>: whether
                their games can be shared outside Ariantra, show up in the public catalog, what name
                details go with them, and who can see their creator profile. Set once — your child
                shares freely within it after, no PIN each time.
              </p>
            </div>
            <a href={FAMILY_PROFILE_URL} className="btn-primary whitespace-nowrap">
              Open family profile →
            </a>
          </article>

          {/* PRD-SHARING Phase 1 (S2, "parent pride push") — a STANDING
              section, not just a one-time notification: every published
              game gets a Share button here, always available, not tied to
              the moment right after a fresh publish. Consent is account-
              level (Sharing & Privacy in the family profile), so one
              shareEnabled flag from loadGames() covers every row. */}
          {games && games.length > 0 && shareEnabled !== null && (
            <article className="card space-y-3 border-l-4 border-brand-300">
              <div>
                <h2 className="text-lg font-semibold">📤 Share your child&rsquo;s games</h2>
                <p className="mt-1 text-sm text-ink-700">
                  Parent shares tend to reach parent groups — a different, often better audience
                  than a kid&rsquo;s own friends for the same game.
                </p>
              </div>
              {!shareEnabled ? (
                <div className="rounded-kid border border-neutral-200 bg-neutral-50 p-3 text-sm text-ink-700">
                  🔒 Sharing isn&rsquo;t turned on yet — turn it on in your{" "}
                  <a href={FAMILY_PROFILE_URL} className="font-semibold text-brand-600 hover:underline">
                    family profile → Sharing &amp; Privacy
                  </a>
                  , then come back — it applies immediately.
                </div>
              ) : (
                <ul className="divide-y divide-neutral-100">
                  {games.filter((g) => g.status === "published").map((g) => (
                    <li key={g.slug} className="py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-ink-900">{g.name}</div>
                          <div className="truncate text-xs text-ink-500">{g.slug}.ariantra.com</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => openShare(g)}
                          className="shrink-0 rounded-full border border-brand-500 px-3.5 py-1.5 text-xs font-bold text-brand-600 hover:bg-brand-50"
                        >
                          📤 Share
                        </button>
                      </div>
                      {shareOpenSlug === g.slug && (
                        shareConfirmedSlug === g.slug ? (
                          <div className="mt-2 rounded-kid border border-emerald-200 bg-emerald-50 p-3 text-center text-sm font-semibold text-emerald-700">
                            🎉 Nice! Thanks for sharing.
                          </div>
                        ) : (
                          <div className="mt-2 rounded-kid border border-neutral-200 bg-neutral-50 p-3">
                            <textarea
                              value={shareMessage}
                              onChange={(e) => setShareMessage(e.target.value)}
                              rows={2}
                              className="mb-2 w-full rounded-lg border border-neutral-200 bg-white p-2 text-sm outline-none focus:border-brand-500"
                            />
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => { openWhatsApp(shareMessage); setTimeout(() => setShareConfirmedSlug(g.slug), 300); }}
                                className="rounded-full bg-[#25d366] px-3.5 py-1.5 text-xs font-bold text-white"
                              >
                                💬 WhatsApp
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (navigator.share) {
                                    navigator.share({ text: shareMessage, url: `https://${g.slug}.ariantra.com/` })
                                      .then(() => setShareConfirmedSlug(g.slug)).catch(() => {});
                                  } else setShareConfirmedSlug(g.slug);
                                }}
                                className="rounded-full bg-brand-500 px-3.5 py-1.5 text-xs font-bold text-white"
                              >
                                📲 More…
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard?.writeText(`https://${g.slug}.ariantra.com/`).catch(() => {});
                                  setShareConfirmedSlug(g.slug);
                                }}
                                className="rounded-full border border-neutral-200 bg-white px-3.5 py-1.5 text-xs font-bold text-ink-700"
                              >
                                🔗 Copy link
                              </button>
                            </div>
                          </div>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          )}

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

          {screenTime && (
            <article className="card space-y-3 border-l-4 border-brand-300">
              <div>
                <h2 className="text-lg font-semibold">⏱️ Daily screen-time alert</h2>
                <p className="mt-1 text-sm text-ink-700">
                  We&rsquo;ll send you one alert here if they go over this many minutes today.
                  Nothing is blocked — your child keeps playing.
                </p>
              </div>
              <p className="text-sm text-ink-700">
                Today: <span className="font-semibold text-ink-900">{screenTime.todayActiveMinutes} min</span>
                {" · "}
                Current cap:{" "}
                <span className="font-semibold text-ink-900">
                  {screenTime.dailyCapMinutes != null ? `${screenTime.dailyCapMinutes} min/day` : "not set"}
                </span>
              </p>
              <form onSubmit={saveScreenTimeCap} className="flex flex-wrap items-center gap-3">
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1440}
                  placeholder="No cap"
                  value={capInput}
                  onChange={(e) => { setCapInput(e.target.value); setCapSaved(false); }}
                  className="w-28 rounded-kid border-2 border-brand-100 px-3 py-2 text-center font-semibold outline-none focus:border-brand-500"
                />
                <span className="text-sm text-ink-500">minutes / day</span>
                <button disabled={capSaving} className="btn-primary disabled:opacity-40">
                  {capSaving ? "Saving…" : "Save"}
                </button>
                {capSaved && <span className="text-sm font-semibold text-emerald-600">✓ Saved</span>}
              </form>
              {capError && <p className="text-sm font-medium text-danger-600">{capError}</p>}
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
