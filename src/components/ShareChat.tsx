"use client";
// Share a conversation (2026-08-06_PRD_ShareConversation.md) — bottom sheet
// launched from the sidebar ⋮ menu. A grown-up approves with the parent PIN
// (same verify-pin → HttpOnly ari_parent cookie flow as publishing; the PIN
// never rides on the share request itself), then the chat gets a revocable
// read-only link. Revoking never needs a PIN.

import { useCallback, useEffect, useRef, useState } from "react";
import { useModalA11y } from "./useModalA11y";
import { signIn } from "@/lib/useAriantraSession";

interface Props {
  chatId: string;
  title: string;
  onClose: () => void;
}

type Step = "creating" | "pin" | "signin" | "ready" | "error";

export function ShareChat({ chatId, title, onClose }: Props) {
  const [step, setStep] = useState<Step>("creating");
  const [url, setUrl] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  // Focus trap + Escape + scroll lock + focus restore. The roles above were
  // declared without any of it, so a keyboard user could never reach this
  // sheet (code review 2026-08-09).
  const dialogRef = useModalA11y({ onClose });
  const started = useRef(false);

  const create = useCallback(async () => {
    setStep("creating");
    setError("");
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/share`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) { setUrl(data.url); setStep("ready"); return; }
      if (res.status === 403) { setStep("pin"); return; } // parent approval needed
      if (res.status === 401) { setStep("signin"); return; }
      if (res.status === 404) {
        setStep("error");
        setError("This chat hasn't synced yet — send one more message in it, then try sharing again.");
        return;
      }
      setStep("error");
      setError("That didn't work — nothing is broken. Try again in a minute.");
    } catch {
      setStep("error");
      setError("That didn't work — nothing is broken. Check the internet and try again.");
    }
  }, [chatId]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void create();
  }, [create]);

  async function verifyPin() {
    setError("");
    const res = await fetch("/api/parent/verify-pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (res.ok) { setPin(""); return void create(); }
    const data = (await res.json().catch(() => ({}))) as { error?: string; attemptsLeft?: number; unlockAt?: number };
    if (res.status === 401 && data.error === "signed_out") { setStep("signin"); return; }
    if (res.status === 404) { setError("No parent PIN is set up yet — a grown-up can set one in the Parent area first."); return; }
    if (res.status === 429) {
      const at = data.unlockAt ? new Date(data.unlockAt).toLocaleTimeString() : "later";
      setError(`Too many tries — the PIN is locked until ${at}.`);
      return;
    }
    setError(`That's not the right PIN — try again!${data.attemptsLeft != null ? ` (${data.attemptsLeft} tries left)` : ""}`);
  }

  function shareIt() {
    if (navigator.share) {
      navigator.share({ title: `${title} — a chat with Ari`, url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
    }
  }

  // Turning the link OFF is a privacy control on a child's chat transcript, so
  // it must never *look* like it worked when it didn't. This used to ignore
  // res.ok, swallow every error, and close unconditionally — on a 401, a 500 or
  // an offline phone the sheet closed as if revoked while the public
  // /share/chat/[token] page stayed live (code review 2026-08-09).
  async function revoke() {
    setRevoking(true);
    setError("");
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/share`, { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      onClose();
    } catch {
      // Stay open, say what is still true, and offer the retry.
      setError("We couldn't turn the link off just yet — it's still on. Check your connection and tap again.");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Share this chat"
      >
        <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-neutral-200" />

        {step === "creating" && (
          <div className="py-6 text-center">
            <div className="mb-2 text-5xl">🔗</div>
            <h3 className="font-display text-xl font-bold">One moment…</h3>
          </div>
        )}

        {step === "signin" && (
          <>
            <h3 className="font-display text-xl font-bold">Ask a grown-up to sign in 🧑‍🚀</h3>
            <p className="mb-4 text-sm text-neutral-500">Sharing a chat needs a grown-up. Sign in and you&rsquo;ll come straight back here.</p>
            <button
              onClick={() => signIn()}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              Sign in →
            </button>
          </>
        )}

        {step === "pin" && (
          <>
            <h3 className="font-display text-xl font-bold">Ask a grown-up 🧑‍🚀</h3>
            <p className="mb-3 text-sm text-neutral-500">
              Sharing &ldquo;{title}&rdquo; makes it readable by anyone with the link. A grown-up
              approves with the parent PIN — you can turn the link off any time.
            </p>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter" && pin.length === 4) void verifyPin(); }}
              placeholder="• • • •"
              aria-label="Parent PIN"
              className="mb-3 w-full rounded-2xl border-2 border-neutral-200 px-4 py-3 text-center text-2xl tracking-[0.5em]"
            />
            {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
            <button
              onClick={() => void verifyPin()}
              disabled={pin.length !== 4}
              className="w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30 disabled:opacity-40"
            >
              Approve &amp; share
            </button>
          </>
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
            <div className="mb-1 text-5xl">🔗</div>
            <h3 className="font-display text-xl font-bold">Your chat link is ready!</h3>
            <p className="mb-3 text-sm text-neutral-500">
              Anyone with this link can READ &ldquo;{title}&rdquo; — they can&rsquo;t change it or
              see your other chats. Turn it off here whenever you like.
            </p>
            <div className="mb-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-3 text-sm font-extrabold text-orange-600 break-all">
              {url}
            </div>
            <button
              onClick={shareIt}
              className="mb-2 block w-full rounded-2xl bg-orange-500 py-3.5 text-base font-extrabold text-white shadow-lg shadow-orange-500/30"
            >
              {copied ? "✓ Copied!" : "📤 Send the link"}
            </button>
            <button
              onClick={() => void revoke()}
              disabled={revoking}
              className="mb-2 block w-full rounded-2xl border-2 border-red-200 py-3 text-base font-bold text-red-600 disabled:opacity-60"
            >
              {revoking ? "Turning it off…" : "🔒 Turn off the link"}
            </button>
            {error && (
              <p className="mb-2 text-center text-sm font-semibold text-red-600" role="alert">
                {error}
              </p>
            )}
            <button onClick={onClose} className="block w-full rounded-2xl border-2 border-neutral-200 py-3 text-base font-bold text-neutral-800">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
