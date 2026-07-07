"use client";
// "🚀 Put it in the Arcade" — bottom-sheet flow (design 2026-07-07, approved):
// name → grown-up PIN → lift-off progress → celebration. Kid-styled: big
// targets, short words, nothing scary. The server route enforces the real
// gates; this component only renders states.

import { useCallback, useEffect, useRef, useState } from "react";
import { nameToSlug } from "@/lib/arcade";
import { signIn, useSession } from "@/lib/useAriantraSession";

interface Props {
  html: string;
  suggestedName?: string;
  onClose: () => void;
}

type Step = "signin" | "name" | "pin" | "publishing" | "done";

const NAME_IDEAS = [
  "Sky Dragon", "Star Dash", "Robo Run", "Mega Maze", "Pixel Quest",
  "Turbo Trails", "Moon Hopper", "Laser Legend", "Wobble World", "Rocket Rally",
];

export function PublishToArcade({ html, suggestedName, onClose }: Props) {
  const [step, setStep] = useState<Step>("name");
  // Sign-in is checked FIRST (before the kid invests in naming + PIN): the
  // family account is required to publish, and signIn() round-trips back to
  // this exact page — the chat survives via chat-store.
  const { status: authStatus } = useSession();
  useEffect(() => {
    if (authStatus === "unauthenticated") setStep("signin");
    if (authStatus === "authenticated") setStep((s) => (s === "signin" ? "name" : s));
  }, [authStatus]);
  const [name, setName] = useState(suggestedName ?? "");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "free" | "taken" | "mine" | "unknown"; suggestions: string[] }>({ state: "idle", suggestions: [] });
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [stage, setStage] = useState(0);
  const checkTimer = useRef<ReturnType<typeof setTimeout>>();

  const slug = nameToSlug(name);
  const isUpdate = check.state === "mine"; // republishing the kid's own game

  // Debounced availability check while the kid types.
  useEffect(() => {
    setCheck({ state: "idle", suggestions: [] });
    if (!slug) return;
    clearTimeout(checkTimer.current);
    setCheck({ state: "checking", suggestions: [] });
    checkTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/arcade/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ check: true, name }),
        });
        const data = (await res.json()) as { free?: boolean; mine?: boolean; suggestions?: string[] };
        // "taken" ONLY on a confirmed answer — a failed check (network, server)
        // must not claim the name is gone; publish re-validates server-side.
        if (res.ok && data.free === true) setCheck({ state: "free", suggestions: [] });
        else if (res.ok && data.free === false && data.mine === true) setCheck({ state: "mine", suggestions: [] });
        else if (res.ok && data.free === false) setCheck({ state: "taken", suggestions: data.suggestions ?? [] });
        else setCheck({ state: "unknown", suggestions: [] });
      } catch {
        setCheck({ state: "unknown", suggestions: [] });
      }
    }, 450);
    return () => clearTimeout(checkTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const shuffle = () => {
    const pick = NAME_IDEAS[Math.floor(Math.random() * NAME_IDEAS.length)]!;
    setName(pick);
  };

  const publish = useCallback(async () => {
    setStep("publishing");
    setError("");
    setStage(1);
    // Stages 1-3 animate on a timer (they map to real phases but we only get
    // one response); the last stage completes when the server answers.
    const t1 = setTimeout(() => setStage(2), 900);
    const t2 = setTimeout(() => setStage(3), 1900);
    try {
      const res = await fetch("/api/arcade/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, html, pin }),
      });
      const data = (await res.json()) as { url?: string; error?: string; suggestions?: string[] };
      clearTimeout(t1);
      clearTimeout(t2);
      if (res.status === 403) { setStep("pin"); setPin(""); setError("That's not the right PIN — try again!"); return; }
      if (res.status === 401) { setStep("signin"); return; } // session expired mid-flow
      if (res.status === 409) { setStep("name"); setCheck({ state: "taken", suggestions: data.suggestions ?? [] }); return; }
      if (!res.ok || !data.url) { setStep("pin"); setError(data.error ?? "That didn't work — nothing is broken. Try again in a minute."); return; }
      setStage(4);
      setLiveUrl(data.url);
      setTimeout(() => setStep("done"), 700);
    } catch {
      clearTimeout(t1);
      clearTimeout(t2);
      setStep("pin");
      setError("That didn't work — nothing is broken. Check the internet and try again.");
    }
  }, [name, html, pin]);

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-neutral-200" />

        {step === "signin" && (
          <>
            <h3 className="font-display text-xl font-bold">Ask a grown-up to sign in 🧑‍🚀</h3>
            <p className="mb-4 text-sm text-neutral-500">
              Games publish under your family&rsquo;s Ariantra account. Sign in and you&rsquo;ll come
              straight back here — <b>your chat and game are safe</b>.
            </p>
            <button
              onClick={() => signIn()}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              Sign in with Google →
            </button>
          </>
        )}

        {step === "name" && (
          <>
            <h3 className="font-display text-xl font-bold">Name your game! 🎮</h3>
            <p className="mb-3 text-sm text-neutral-500">This becomes its very own web address.</p>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dragon Flyer"
              className="w-full rounded-xl border-2 border-orange-500 px-4 py-3 text-base font-bold outline-none"
            />
            <p className="mt-2 min-h-5 text-xs font-bold">
              {check.state === "checking" && <span className="text-neutral-400">checking…</span>}
              {check.state === "free" && <span className="text-emerald-600">✓ {slug}.ariantra.com is free!</span>}
              {check.state === "mine" && <span className="text-emerald-600">🔄 that&rsquo;s YOUR game — this updates {slug}.ariantra.com!</span>}
              {check.state === "taken" && <span className="text-red-500">someone got that one first — try a 🎲 idea!</span>}
              {check.state === "unknown" && <span className="text-neutral-400">couldn&rsquo;t check the name — you can still continue</span>}
            </p>
            <div className="mb-4 mt-1 flex flex-wrap gap-1.5">
              {(check.state === "taken" && check.suggestions.length > 0 ? check.suggestions : []).map((s) => (
                <button key={s} onClick={() => setName(s.replace(/-/g, " "))} className="rounded-full border border-neutral-200 px-3 py-1 text-xs font-bold text-neutral-600 hover:border-orange-400">
                  {s}
                </button>
              ))}
              <button onClick={shuffle} className="rounded-full border border-neutral-200 px-3 py-1 text-xs font-bold text-neutral-600 hover:border-orange-400">
                🎲 give me an idea
              </button>
            </div>
            <button
              disabled={!slug || check.state === "taken"}
              onClick={() => setStep("pin")}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30 disabled:opacity-40"
            >
              {isUpdate ? "Next → update my game" : "Next → ask a grown-up"}
            </button>
          </>
        )}

        {step === "pin" && (
          <>
            <h3 className="font-display text-xl font-bold">Ask a grown-up 🧑‍🚀</h3>
            <p className="mb-3 text-sm text-neutral-500">
              {isUpdate ? (
                <>This replaces the version of <b>{name}</b> that&rsquo;s already on the internet. A grown-up needs to say OK.</>
              ) : (
                <>Publishing puts <b>{name}</b> on the internet where anyone can play it. A grown-up needs to say OK.</>
              )}
            </p>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Parent PIN"
              className="w-full rounded-xl border-2 border-neutral-200 px-4 py-3 text-center text-xl font-extrabold tracking-[0.5em] outline-none focus:border-orange-500"
            />
            <p className="mb-3 mt-1 text-center text-xs text-neutral-400">Same PIN as the Parent Dashboard</p>
            {error && <p className="mb-2 text-center text-xs font-bold text-red-500">{error}</p>}
            <button
              disabled={pin.length < 4}
              onClick={() => void publish()}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30 disabled:opacity-40"
            >
              {isUpdate ? `🔄 Update ${name}` : `🚀 Publish ${name}`}
            </button>
          </>
        )}

        {step === "publishing" && (
          <div className="py-4 text-center">
            <div className="mb-2 text-5xl">🚀</div>
            <h3 className="font-display mb-3 text-xl font-bold">Lifting off…</h3>
            <ul className="mx-auto max-w-60 space-y-2 text-left text-sm font-bold">
              {["Packing your game", "Stamping your name on it", `Launching to ${slug}.ariantra.com`, "Taking its picture for the Arcade"].map((label, i) => (
                <li key={label} className={i + 1 < stage ? "text-emerald-600" : i + 1 === stage ? "text-neutral-900" : "text-neutral-300"}>
                  {i + 1 < stage ? "✅" : i + 1 === stage ? "🚀" : "◻"} {label}
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === "done" && (
          <div className="py-2 text-center">
            <div className="mb-1 text-5xl">🏆</div>
            <h3 className="font-display text-xl font-bold">{name} is {isUpdate ? "UPDATED" : "LIVE"}! 🎉</h3>
            <p className="mb-3 text-sm text-neutral-500">{isUpdate ? "The new version is playing at the same address." : "You’re a real game maker now."}</p>
            <div className="mb-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-3">
              <div className="text-sm font-extrabold text-orange-600">{liveUrl.replace(/^https:\/\//, "").replace(/\/$/, "")}</div>
              <div className="mt-1 text-[11px] text-neutral-400">High scores &amp; leaderboard: ON automatically 🏆</div>
            </div>
            <a href={liveUrl} target="_blank" rel="noreferrer" className="mb-2 block w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white">
              ▶ Play at my address
            </a>
            <a href="https://games.ariantra.com/" target="_blank" rel="noreferrer" className="block w-full rounded-2xl border-2 border-neutral-200 py-3 text-base font-bold text-neutral-800">
              🕹 See it in the Arcade
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
