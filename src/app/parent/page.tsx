"use client";
// Parent dashboard — per-family PIN (PRD-PARENT-AUTH-ALERT-SCOPING Phase 1).
// Flow: live parent session → alerts; otherwise verify the 4-digit PIN
// (POST body, throttled server-side); first visit or "forgot PIN" → set-PIN
// interstitial, which requires a 6-digit email OTP (BUG-FIX-LOG 2026-07-27 —
// REPLACED the old "fresh SSO login" gate: that gate re-used the platform
// login, but a live Google browser session on a shared family device clears
// it with no secret only the parent has, so a kid locked out of guessing the
// PIN could just reset it). Guests see sign-up copy, never a PIN form (D3).

import { useCallback, useEffect, useState } from "react";
import { signIn, useSession } from "@/lib/useAriantraSession";
import { whatsappShareUrl } from "@/lib/share-links";
import { SparksParentCard } from "@/components/SparksParentCard";
import type { ParentAlert } from "@/types/alert.types";
import type { HelpReasonCode, HelpTicketStatus } from "@/types/help.types";

type PinFlowMode = "first-time" | "reset";

/** What GET /api/parent/help returns. The helper stays anonymous here too —
 *  which admin answered is not a parent's business, only what was said. */
interface ParentHelpTicket {
  id: string;
  reasonCode: HelpReasonCode;
  status: HelpTicketStatus;
  transcript: string | null;
  createdAt: number;
  updatedAt: number;
  replies: Array<{ id: string; body: string; createdAt: number; canned: boolean }>;
}

/** Plain-English reasons — a parent shouldn't have to decode `wont_move`. */
const HELP_REASON_TEXT: Record<HelpReasonCode, string> = {
  wont_move: "The game wouldn’t move",
  blank: "The screen was blank",
  looks_wrong: "It looked wrong",
  no_sound: "There was no sound",
  dont_know: "Didn’t know what to ask",
  other: "Something else (their own words)",
};

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

// WhatsApp share is a plain anchor to wa.me — see src/lib/share-links.ts for
// why the whatsapp:// deep-link + delayed-window.open approach is banned
// (BUG-FIX-LOG 2026-07-18: it silently opened nothing without the app).

type View =
  | { kind: "loading" }
  | { kind: "verify" }
  | { kind: "set"; mode: PinFlowMode }
  | { kind: "signed-out" }
  | { kind: "alerts"; alerts: ParentAlert[] };

export default function ParentPage() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState("");
  // Locked-out recovery: separate from `error` so the verify form can render
  // a dedicated callout with a reset escape hatch instead of one red line
  // with no way forward (BUG-FIX-LOG 2026-07-27).
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  // PIN-reset OTP step (BUG-FIX-LOG 2026-07-27) — see requestOtp/handleSet.
  const [otpRequested, setOtpRequested] = useState(false);
  const [otpMaskedEmail, setOtpMaskedEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpSending, setOtpSending] = useState(false);
  const [otpRequestError, setOtpRequestError] = useState("");
  // First-contact email capture (BUG-FIX-LOG 2026-08-08). The platform holds
  // the only decryptable contact address, and most accounts have none — which
  // made the PIN gate a dead end. When the server says `needsEmail`, we ask
  // for one here instead of sending the parent away to Studio.
  const [needsEmail, setNeedsEmail] = useState(false);
  const [parentEmail, setParentEmail] = useState("");
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
  // 4-tab restructure (PRD parent-tabs, 2026-07-28) — client-state only, no
  // router/URL involvement, matching this page's existing pattern. Only read
  // when view.kind === "alerts"; declared unconditionally alongside the rest
  // of this component's state so hook order stays stable.
  const [activeTab, setActiveTab] = useState<
    "safety" | "sparks" | "alerts" | "help" | "family-profile"
  >("safety");
  // Community Help (docs/PRD-COMMUNITY-HELP.md §3.6/§3.8 c.3): every word a
  // helper sent your child, readable without opting in to anything. Replies
  // ALSO write a ParentAlert, so the Alerts tab carries them too — this tab is
  // the full thread, in order, with each ticket's outcome.
  const [helpTickets, setHelpTickets] = useState<ParentHelpTicket[] | null>(null);
  useEffect(() => {
    if (activeTab !== "help" || helpTickets) return;
    void (async () => {
      try {
        const res = await fetch("/api/parent/help", { cache: "no-store" });
        setHelpTickets(res.ok ? ((await res.json()).tickets as ParentHelpTicket[]) : []);
      } catch {
        setHelpTickets([]);
      }
    })();
  }, [activeTab, helpTickets]);

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
  // parent with a LIVE parent session (this same visit to the Parent area)
  // skips the PIN entirely; leaving the area always clears that session, so
  // coming back always re-prompts (owner decision 2026-08-01 — the parent
  // session is scoped to "while you're in the Parent area", not a rolling TTL).
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

  // Clear the parent session the moment the Parent area is left, so a return
  // visit — whether via in-app navigation or a fresh tab — always needs the
  // PIN again. pagehide covers tab close/hard navigation (sendBeacon survives
  // page teardown); the unmount cleanup covers in-app client-side navigation.
  useEffect(() => {
    const clearParentSession = () => {
      navigator.sendBeacon?.("/api/parent/session/clear");
    };
    window.addEventListener("pagehide", clearParentSession);
    return () => {
      window.removeEventListener("pagehide", clearParentSession);
      clearParentSession();
    };
  }, []);

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
    setLockedUntil(null);
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
    if (res.status === 404) { resetOtpState(); setView({ kind: "set", mode: "first-time" }); return; }
    if (res.status === 429) {
      // Lockout only blocks re-guessing — reset (email OTP) still works, so
      // the recovery callout below stays available immediately rather than
      // making a locked-out parent wait it out.
      setLockedUntil(data.unlockAt ?? null);
      return;
    }
    setError(
      `Wrong PIN${typeof data.attemptsLeft === "number" ? ` — ${data.attemptsLeft} tries left` : ""}.`,
    );
  }

  function resetOtpState() {
    setOtpRequested(false);
    setOtpMaskedEmail("");
    setOtpCode("");
    setOtpRequestError("");
    setNeedsEmail(false);
    setParentEmail("");
  }

  function startReset() {
    setError("");
    setLockedUntil(null);
    setPin("");
    setPin2("");
    resetOtpState();
    setView({ kind: "set", mode: "reset" });
  }

  async function requestOtp() {
    setOtpRequestError("");
    setOtpSending(true);
    try {
      const res = await fetch("/api/parent/pin-otp/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parentEmail.trim() ? { email: parentEmail.trim() } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        maskedEmail?: string;
        retryAt?: number;
        needsEmail?: boolean;
      };
      if (res.status === 401) { setView({ kind: "signed-out" }); return; }
      if (res.ok) {
        setOtpRequested(true);
        setNeedsEmail(false);
        setOtpMaskedEmail(data.maskedEmail ?? "your email");
        setOtpCode("");
        return;
      }
      if (data.needsEmail) {
        // Not an error the parent caused — it is a question we should have
        // asked earlier. Show the field; keep any message as guidance.
        setNeedsEmail(true);
        setOtpRequestError(parentEmail.trim() ? (data.message ?? "") : "");
        return;
      }
      if (res.status === 429) {
        const at = data.retryAt ? new Date(data.retryAt).toLocaleTimeString() : "shortly";
        setOtpRequestError(
          data.error === "daily-limit"
            ? `Too many codes requested today — try again after ${at}.`
            : `Please wait a moment before requesting another code (around ${at}).`,
        );
        // A code from an earlier request may still be valid — let them enter it.
        setOtpRequested(true);
        return;
      }
      setOtpRequestError(data.message ?? "Couldn't send the code — try again.");
    } finally {
      setOtpSending(false);
    }
  }

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (view.kind !== "set") return;
    setError("");
    if (pin !== pin2) {
      setError("Those don't match — type the same 4 digits twice.");
      return;
    }
    const res = await fetch("/api/parent/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin, otp: otpCode }),
    });
    if (res.ok) {
      setPin("");
      setPin2("");
      resetOtpState();
      await loadAlerts();
      void loadGames();
      void loadScreenTime();
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      attemptsLeft?: number;
    };
    if (res.status === 401) { setView({ kind: "signed-out" }); return; }
    switch (data.error) {
      case "otp_not_requested":
        setError('Request a code first — tap "Send code to my email" above.');
        return;
      case "otp_expired":
        setError("That code expired — send a new one.");
        setOtpRequested(false);
        setOtpCode("");
        return;
      case "otp_too_many_attempts":
        setError("Too many wrong codes — send a new one.");
        setOtpRequested(false);
        setOtpCode("");
        return;
      case "otp_wrong":
        setError(
          `Wrong code${typeof data.attemptsLeft === "number" ? ` — ${data.attemptsLeft} tries left` : ""}.`,
        );
        setOtpCode("");
        return;
      default:
        setError(data.message ?? "That PIN won't work — pick 4 digits that aren't an easy pattern.");
    }
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

          {lockedUntil !== null ? (
            <div className="space-y-3 rounded-kid border border-warn-500/40 bg-warn-50 p-4">
              <p className="text-sm font-medium text-ink-900">
                🔒 Too many tries — locked until{" "}
                <span className="font-semibold">{new Date(lockedUntil).toLocaleTimeString()}</span>.
              </p>
              <p className="text-sm text-ink-700">
                You don&rsquo;t have to wait — resetting your PIN works right away.
              </p>
              <button type="button" onClick={startReset} className="btn-primary w-full">
                Forgot your PIN? Reset it now →
              </button>
            </div>
          ) : (
            <>
              {error && <p className="text-sm font-medium text-danger-600">{error}</p>}
              <button disabled={pin.length !== 4} className="btn-primary w-full disabled:opacity-40">
                Unlock
              </button>
              <div className="flex items-center justify-between gap-2 pt-1 text-sm">
                <button type="button" onClick={startReset} className="text-brand-600 hover:underline">
                  Forgot your PIN?
                </button>
                <button
                  type="button"
                  onClick={() => { setError(""); resetOtpState(); setView({ kind: "set", mode: "first-time" }); }}
                  className="text-ink-500 hover:underline"
                >
                  First time here?
                </button>
              </div>
            </>
          )}
        </form>
      )}

      {view.kind === "set" && (
        <div className="card max-w-sm space-y-4">
          <label className="block text-lg font-semibold">
            {view.mode === "reset" ? "Reset your parent PIN" : "Set your family’s parent PIN"}
          </label>

          {!otpRequested ? (
            <>
              <p className="text-sm text-ink-700">
                {view.mode === "reset" ? (
                  <>
                    First, we&rsquo;ll email a 6-digit code to confirm it&rsquo;s really you — a new
                    PIN can&rsquo;t be set without it.
                  </>
                ) : (
                  <>
                    4 digits. You&rsquo;ll use it to open this page and to approve putting games on
                    the internet. First, we&rsquo;ll email a 6-digit code to confirm it&rsquo;s really
                    you.
                  </>
                )}
              </p>
              {needsEmail && (
                <div className="space-y-2 rounded-kid bg-brand-50 p-3">
                  <label htmlFor="parent-email" className="block text-sm font-semibold text-ink-800">
                    Parent&rsquo;s email address
                  </label>
                  <p className="text-sm text-ink-700">
                    We don&rsquo;t have one for this account yet. We&rsquo;ll send the 6-digit code
                    here.
                  </p>
                  <input
                    id="parent-email"
                    autoFocus
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={parentEmail}
                    onChange={(e) => setParentEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-kid border-2 border-brand-100 px-4 py-3 outline-none focus:border-brand-500"
                  />
                  {/* Purpose limitation AND the policy links, at the point of
                      capture — the parent should never have to guess what an
                      address will be used for, or go hunting for the terms they
                      are agreeing to. Absolute URLs: these pages live on the
                      marketing site (Hostinger), not in this app. The .html
                      extension is load-bearing — /privacy and /terms are 404. */}
                  <p className="text-xs text-ink-600">
                    Used only to confirm it&rsquo;s you: parent codes and safety notices about your
                    child&rsquo;s account. Never shown on games, never shared, no marketing. You can
                    change it any time in your Studio account. See our{" "}
                    <a
                      href="https://ariantra.com/privacy.html"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-600 underline"
                    >
                      Privacy Policy
                    </a>{" "}
                    and{" "}
                    <a
                      href="https://ariantra.com/terms.html"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-600 underline"
                    >
                      Terms
                    </a>
                    .
                  </p>
                </div>
              )}
              {otpRequestError && <p className="text-sm font-medium text-danger-600">{otpRequestError}</p>}
              <button
                type="button"
                onClick={requestOtp}
                disabled={otpSending || (needsEmail && !parentEmail.trim())}
                className="btn-primary w-full disabled:opacity-40"
              >
                {otpSending ? "Sending…" : needsEmail ? "Save email & send code" : "Send code to my email"}
              </button>
            </>
          ) : (
            <form onSubmit={handleSet} className="space-y-4">
              <p className="text-sm text-ink-700">
                We sent a 6-digit code to <span className="font-semibold">{otpMaskedEmail}</span>. It
                expires in 10 minutes.
              </p>
              {otpRequestError && <p className="text-sm font-medium text-danger-600">{otpRequestError}</p>}
              <input
                autoFocus
                inputMode="numeric"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                placeholder="6-digit code"
                className="w-full rounded-kid border-2 border-brand-100 px-4 py-3 text-center text-xl font-bold tracking-[0.3em] outline-none focus:border-brand-500"
              />
              {pinInput(pin, setPin, "New PIN", false)}
              {pinInput(pin2, setPin2, "Same PIN again")}
              {error && <p className="text-sm font-medium text-danger-600">{error}</p>}
              <button
                disabled={pin.length !== 4 || pin2.length !== 4 || otpCode.length !== 6}
                className="btn-primary w-full disabled:opacity-40"
              >
                {view.mode === "reset" ? "Save new PIN" : "Save PIN"}
              </button>
              <button
                type="button"
                onClick={requestOtp}
                disabled={otpSending}
                className="w-full text-sm text-brand-600 hover:underline disabled:opacity-40"
              >
                {otpSending ? "Sending…" : "Resend code"}
              </button>
            </form>
          )}

          {view.mode === "reset" && (
            <button
              type="button"
              onClick={() => { setError(""); setPin(""); setPin2(""); resetOtpState(); setView({ kind: "verify" }); }}
              className="w-full text-sm text-ink-500 hover:underline"
            >
              ← Back to PIN entry
            </button>
          )}
        </div>
      )}

      {view.kind === "alerts" && (
        <section className="space-y-3">
          {/* 4-tab strip (PRD parent-tabs) — client-state only, matches this
              page's existing pattern of no router/URL involvement. Each tab
              gets a small leading icon so the strip reads at a glance. */}
          <div role="tablist" aria-label="Parent dashboard sections" className="flex flex-wrap gap-2 border-b border-neutral-200 pb-2">
            {(
              [
                { key: "safety", icon: "🛡️", label: "Safety & Security" },
                { key: "sparks", icon: "⚡", label: "Sparks Management" },
                { key: "alerts", icon: "🔔", label: "Alerts" },
                { key: "help", icon: "🆘", label: "Help requests" },
                { key: "family-profile", icon: "👨‍👩‍👧", label: "Family profile" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                  activeTab === tab.key
                    ? "bg-brand-500 text-white"
                    : "bg-neutral-100 text-ink-700 hover:bg-neutral-200"
                }`}
              >
                <span className="text-xs" aria-hidden="true">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "safety" && (
            <>
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
                                  <a
                                    href={whatsappShareUrl(shareMessage)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => setShareConfirmedSlug(g.slug)}
                                    className="rounded-full bg-whatsapp px-3.5 py-1.5 text-xs font-bold text-white no-underline"
                                  >
                                    💬 WhatsApp
                                  </a>
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
            </>
          )}

          {activeTab === "sparks" && (
            <>
              {/* Sparks: exact balance + full statement + parent-only share reward
                  (PRD-SPARKS Phase 4 — precision is parent-facing by design). */}
              <SparksParentCard />
            </>
          )}

          {activeTab === "alerts" && (
            <>
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
            </>
          )}

          {activeTab === "help" && (
            <>
              <article className="card border-l-4 border-brand-300">
                <h2 className="text-lg font-semibold">🆘 Help requests</h2>
                <p className="mt-1 text-sm text-ink-700">
                  When your child gets stuck they can ask a grown-up at Ariantra for help. Every reply is
                  shown here in full — your child cannot write back, and no one can start a conversation
                  with them. Replies usually arrive within a day.
                </p>
              </article>

              {helpTickets === null && <p className="text-ink-500">Loading…</p>}
              {helpTickets?.length === 0 && (
                <p className="text-ink-500">No help requests yet. 🎉</p>
              )}
              {helpTickets?.map((t) => (
                <article key={t.id} className="card border-l-4 border-ink-700">
                  <div className="flex items-center justify-between text-sm text-ink-500">
                    <span>
                      {HELP_REASON_TEXT[t.reasonCode] ?? t.reasonCode} ·{" "}
                      {t.status === "open"
                        ? "waiting for a helper"
                        : t.status === "answered"
                          ? "answered"
                          : "sorted"}
                    </span>
                    <time>{new Date(t.createdAt).toLocaleString()}</time>
                  </div>
                  {t.transcript && (
                    <p className="mt-2 font-medium text-ink-900">“{t.transcript}”</p>
                  )}
                  {t.replies.length === 0 && (
                    <p className="mt-2 text-ink-500">No reply yet.</p>
                  )}
                  {t.replies.map((r) => (
                    <div key={r.id} className="mt-2 rounded-xl bg-neutral-50 px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                        A helper at Ariantra · {r.canned ? "standard reply" : "written by hand"}
                      </p>
                      <p className="mt-1 text-ink-900">{r.body}</p>
                      <time className="text-xs text-ink-500">{new Date(r.createdAt).toLocaleString()}</time>
                    </div>
                  ))}
                </article>
              ))}
            </>
          )}

          {activeTab === "family-profile" && (
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
          )}
        </section>
      )}
    </main>
  );
}
