"use client";
// "🧪 Test link" (PRD-MULTIPLAYER.md Phase 4, §Preview-pane hosting; renamed
// from "🎮 Invite a friend to test" 2026-08-06 — the old name read like it
// starts a multiplayer session) — bottom-sheet, deliberately simpler than
// PublishToArcade: no naming step, no parent PIN (nothing is published — see
// api/arcade/test-link route's own comment). Tapping the button immediately
// creates the link.

import { useCallback, useEffect, useRef, useState } from "react";
import { signIn, useSession } from "@/lib/useAriantraSession";

interface Props {
  html: string;
  suggestedName?: string;
  onClose: () => void;
}

type Step = "signin" | "creating" | "ready" | "error";

export function InviteToTest({ html, suggestedName, onClose }: Props) {
  const { status: authStatus } = useSession();
  const [step, setStep] = useState<Step>("creating");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  const create = useCallback(async () => {
    setStep("creating");
    setError("");
    try {
      const res = await fetch("/api/arcade/test-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: suggestedName || "My game", html }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.status === 401) { setStep("signin"); return; }
      if (!res.ok || !data.url) { setStep("error"); setError(data.error ?? "That didn't work — nothing is broken. Try again in a minute."); return; }
      setUrl(data.url);
      setStep("ready");
    } catch {
      setStep("error");
      setError("That didn't work — nothing is broken. Check the internet and try again.");
    }
  }, [html, suggestedName]);

  useEffect(() => {
    if (authStatus === "unauthenticated") { setStep("signin"); return; }
    if (authStatus !== "authenticated" || started.current) return;
    started.current = true;
    void create();
  }, [authStatus, create]);

  const share = useCallback(() => {
    if (navigator.share) {
      navigator.share({ title: "Come play with me!", url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
    }
  }, [url]);

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
            <p className="mb-4 text-sm text-neutral-500">Sign in and you&rsquo;ll come straight back here.</p>
            <button
              onClick={() => signIn()}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              Sign in →
            </button>
          </>
        )}

        {step === "creating" && (
          <div className="py-6 text-center">
            <div className="mb-2 text-5xl">🧪</div>
            <h3 className="font-display text-xl font-bold">Getting a test link ready…</h3>
          </div>
        )}

        {step === "error" && (
          <>
            <h3 className="font-display text-xl font-bold">Oops! 😅</h3>
            <p className="mb-4 text-sm text-red-500">{error}</p>
            <button
              onClick={() => void create()}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              Try again
            </button>
          </>
        )}

        {step === "ready" && (
          <div className="py-2 text-center">
            <div className="mb-1 text-5xl">🧪</div>
            <h3 className="font-display text-xl font-bold">Your test link is ready!</h3>
            {/* Owner UAT 2026-08-06 round 2: the link alone does NOT put two
                people in one session — someone must OPEN it, tap 🎮 and host,
                then forward the room link. Say exactly that, in steps. */}
            <p className="mb-3 text-sm text-neutral-500">
              Try your multiplayer game for real before it goes live: open the link, tap 🎮 in the
              game and pick <b>Invite a friend</b> — that makes a room link that brings your friend
              straight in. Nothing is published, and this test link stops working in 2 hours.
            </p>
            <div className="mb-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-sm font-extrabold text-orange-600 break-all">
              {url}
            </div>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-2 block w-full rounded-2xl bg-orange-500 py-3.5 text-center text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              ▶ Open it and host
            </a>
            <button
              onClick={share}
              className="mb-2 block w-full rounded-2xl border-2 border-orange-500 py-3 text-base font-extrabold text-orange-600"
            >
              {copied ? "✓ Copied!" : "📤 Send the link instead"}
            </button>
            <button onClick={onClose} className="block w-full rounded-2xl border-2 border-neutral-200 py-3 text-base font-bold text-neutral-800">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
