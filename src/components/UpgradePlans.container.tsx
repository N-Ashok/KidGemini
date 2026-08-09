"use client";
// Container for the upgrade page. Requires sign-in, lists Sparks packs, and drives Razorpay Checkout:
//   1. POST /api/billing/order  → { orderId, keyId, amount, currency }
//   2. open Razorpay Checkout with that order
//   3. on success, POST /api/billing/verify (webhook is the source of truth; this is the fast UI confirm)
// The key SECRET never reaches here — only the publishable keyId, returned per-order by the server.
//
// 2026-07-27 Phase 5: Sparks packs replaced the old yearly-access plans —
// repeatable one-time top-ups, not a single "active plan" state, so there is
// no longer an already-paid gate blocking a second purchase (dropped along
// with the old /api/billing/status check).

import { useEffect, useState } from "react";
import { signIn, useSession } from "@/lib/useAriantraSession";
import { SPARK_PACKS, findPack } from "@/lib/billing.config";
import { PlanCard } from "./PlanCard";

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

// Minimal typing for the globally-injected Razorpay Checkout (no SDK / no `any`).
interface RazorpayHandlerResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}
interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { email?: string; name?: string };
  theme?: { color?: string };
  handler: (response: RazorpayHandlerResponse) => void;
  modal?: { ondismiss?: () => void };
}
interface RazorpayInstance {
  open: () => void;
}
type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;
declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

function loadCheckout(): Promise<RazorpayConstructor> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve(window.Razorpay);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    const onload = () =>
      window.Razorpay ? resolve(window.Razorpay) : reject(new Error("Razorpay failed to load"));
    if (existing) {
      existing.addEventListener("load", onload, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = onload;
    script.onerror = () => reject(new Error("Razorpay failed to load"));
    document.body.appendChild(script);
  });
}

type Status = "idle" | "starting" | "success" | "error";

export function UpgradePlans() {
  const { status: authStatus, data: session } = useSession();
  const [pending, setPending] = useState<string | null>(null); // pack key being purchased
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [autoStarted, setAutoStarted] = useState(false);
  // 2026-08-07: the ₹120 trial pack is once-only. null = unknown (show the
  // card optimistically — the order route is the enforcer); true = hide it.
  const [trialUsed, setTrialUsed] = useState<boolean | null>(null);
  // Parent PIN gate (owner ask 2026-08-09). The SERVER decides — /api/billing/order
  // answers 403 parent_pin_required — and this prompt is how a parent satisfies
  // it without leaving the page and losing the pack they picked.
  const [pinFor, setPinFor] = useState<string | null>(null); // pack key awaiting a PIN
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinBusy, setPinBusy] = useState(false);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    let cancelled = false;
    void fetch("/api/wallet")
      .then((r) => (r.ok ? r.json() : null))
      .then((w: { trialUsed?: boolean } | null) => {
        if (!cancelled && typeof w?.trialUsed === "boolean") setTrialUsed(w.trialUsed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  // Deep link from ariantra.com's pricing section: /upgrade?plan=<key> opens
  // Checkout for that pack as soon as the signed-in state is known. Signed-out
  // visitors see the sign-in gate first; the param survives sign-in because
  // Auth.js returns to the same URL. Packs are repeatable, so unlike the old
  // yearly plans this never checks an "already paid" gate first.
  useEffect(() => {
    if (autoStarted || authStatus !== "authenticated") return;
    const key = new URLSearchParams(window.location.search).get("plan");
    if (key && findPack(key)) {
      setAutoStarted(true);
      void handleSelect(key);
    }
    // handleSelect is stable in practice (no memoization in this component).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, autoStarted]);

  async function handleSelect(planKey: string) {
    // One purchase at a time. PlanCard only disables the card matching
    // `pending`, so during the "Opening…" window — script load plus the
    // /api/billing/order round trip, seconds on a phone — every OTHER pack
    // stayed clickable, creating a second Razorpay order and opening a second
    // checkout. PayAnyAmount already gates on !pending; this didn't
    // (code review 2026-08-09).
    if (pending) return;
    setStatus("idle");
    setMessage("");
    setPending(planKey);
    try {
      const Razorpay = await loadCheckout();
      const res = await fetch("/api/billing/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKey }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        if (detail.error === "parent_pin_required") {
          // Not an error to apologise for — it's the gate doing its job. Keep
          // the chosen pack so the purchase resumes on the same tap.
          setPinFor(planKey);
          setPin("");
          setPinError("");
          setPending(null);
          return;
        }
        if (detail.error === "trial_used") {
          setTrialUsed(true);
          throw new Error("You've already used your one-time trial pack — the Starter pack is the next step! ⚡");
        }
        throw new Error(`Couldn't start checkout (${res.status}).`);
      }
      const order = (await res.json()) as {
        orderId: string;
        amount: number;
        currency: string;
        keyId: string;
        planLabel: string;
      };

      const rzp = new Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: "Ari",
        description: `${order.planLabel} — Ariantra Sparks`,
        prefill: { email: session?.user?.email ?? undefined, name: session?.user?.name ?? undefined },
        theme: { color: "#262626" },
        modal: { ondismiss: () => setPending(null) },
        handler: async (resp) => {
          try {
            const v = await fetch("/api/billing/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(resp),
            });
            if (!v.ok) throw new Error("Payment could not be verified.");
            const result = (await v.json()) as { sparksCredited?: number; pending?: boolean };
            setStatus("success");
            setMessage(
              result.pending
                ? "Payment received — we're confirming it. Your Sparks will land shortly."
                : `Payment successful — ${(result.sparksCredited ?? 0).toLocaleString()} ⚡ added to your wallet! 🎉`,
            );
          } catch {
            // Webhook is the source of truth, so the payment may still be recorded server-side.
            setStatus("error");
            setMessage("Payment received — we're confirming it. If anything looks off, contact support.");
          } finally {
            setPending(null);
          }
        },
      });
      rzp.open();
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message || "Something went wrong. Please try again.");
      setPending(null);
    }
  }

  /** Exchange the PIN for the short-lived parent-session cookie, then resume
   *  the purchase the parent already chose. Every failure says what to do
   *  next — no dead ends (CLAUDE.md §6). */
  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    if (!pinFor || pinBusy) return;
    setPinBusy(true);
    setPinError("");
    try {
      const res = await fetch("/api/parent/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        const resume = pinFor;
        setPinFor(null);
        setPin("");
        await handleSelect(resume);
        return;
      }
      const detail = (await res.json().catch(() => ({}))) as { error?: string; attemptsLeft?: number; unlockAt?: number };
      if (detail.error === "locked") {
        const mins = detail.unlockAt ? Math.max(1, Math.ceil((detail.unlockAt - Date.now()) / 60_000)) : 15;
        setPinError(`Too many tries — the PIN is locked for about ${mins} minute${mins === 1 ? "" : "s"}. You can come back and buy after that.`);
      } else if (detail.error === "wrong_pin") {
        setPinError(
          detail.attemptsLeft !== undefined
            ? `That PIN didn't match — ${detail.attemptsLeft} ${detail.attemptsLeft === 1 ? "try" : "tries"} left.`
            : "That PIN didn't match. Try again?",
        );
      } else if (detail.error === "not_set") {
        setPinError("No parent PIN is set on this account yet — set one in the Parent area, then come back.");
      } else {
        setPinError("Couldn't check that PIN just now. Try again in a moment.");
      }
    } catch {
      setPinError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPinBusy(false);
    }
  }

  if (authStatus === "loading") {
    return <div className="h-full w-full bg-white" aria-busy="true" />;
  }

  if (authStatus === "unauthenticated") {
    return (
      <main className="flex h-full w-full flex-col items-center justify-center gap-4 bg-white p-6 text-center">
        <h1 className="text-2xl font-semibold text-neutral-800">Sign in to upgrade</h1>
        <p className="text-sm text-neutral-600">You need an account to manage a subscription.</p>
        <button
          onClick={() => signIn()}
          className="rounded-full bg-neutral-800 px-5 py-3 text-base font-medium text-white hover:bg-neutral-700"
        >
          🔆 Sign in to Ariantra
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center px-6 py-12 text-center">
      <a href="/" className="self-start text-sm text-neutral-500 hover:text-neutral-700">
        ← Back to chat
      </a>
      <h1 className="mt-6 text-3xl font-bold text-neutral-900">Buy Sparks ⚡</h1>
      <p className="mt-2 max-w-md text-sm text-neutral-600">
        1 Spark = 1 paisa — you pay only for the AI work each ask actually
        uses. Sparks never expire, and publishing a game is always free.
      </p>

      <div className="mt-8 flex flex-col items-stretch justify-center gap-6 sm:flex-row">
        {SPARK_PACKS.filter((pack) => !pack.trialOnce || trialUsed !== true).map((pack) => (
          <PlanCard
            key={pack.key}
            plan={pack}
            highlight={pack.key === "pack1000"}
            busy={pending === pack.key}
            onSelect={() => handleSelect(pack.key)}
          />
        ))}
      </div>

      {/* Parent PIN step. Shown only when the server asked for it, so a family
          without a PIN never meets this screen. */}
      {pinFor && (
        <form
          onSubmit={submitPin}
          className="mt-8 w-full max-w-sm rounded-kid border border-neutral-300 bg-white p-5 text-left"
        >
          <h2 className="text-base font-semibold text-neutral-800">🔒 Grown-up check</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Enter your parent PIN to buy {findPack(pinFor)?.label ?? "this pack"}. This keeps Sparks
            purchases in a grown-up&rsquo;s hands.
          </p>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            aria-label="Parent PIN"
            placeholder="PIN"
            className="mt-3 w-full rounded-full border border-neutral-300 px-4 py-3 text-base tracking-[0.4em]"
          />
          {pinError && <p className="mt-2 text-sm font-medium text-red-600">{pinError}</p>}
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={pinBusy || !pin}
              className="flex-1 rounded-full bg-neutral-800 px-4 py-3 text-base font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {pinBusy ? "Checking…" : "Continue to payment"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPinFor(null);
                setPin("");
                setPinError("");
              }}
              className="rounded-full border border-neutral-300 px-4 py-3 text-base font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Cancel
            </button>
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            Forgotten it? You can reset the PIN from the Parent area.
          </p>
        </form>
      )}

      {message && (
        <p
          className={`mt-6 text-sm font-medium ${status === "success" ? "text-green-700" : "text-red-600"}`}
        >
          {message}
        </p>
      )}

      <p className="mt-10 max-w-md text-xs text-neutral-400">
        Payments are processed securely by Razorpay. A grown-up should complete the purchase. 🛡️
      </p>
    </main>
  );
}
