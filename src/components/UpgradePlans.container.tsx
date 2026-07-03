"use client";
// Container for the upgrade page. Requires sign-in, lists plans, and drives Razorpay Checkout:
//   1. POST /api/billing/order  → { orderId, keyId, amount, currency }
//   2. open Razorpay Checkout with that order
//   3. on success, POST /api/billing/verify (webhook is the source of truth; this is the fast UI confirm)
// The key SECRET never reaches here — only the publishable keyId, returned per-order by the server.

import { useEffect, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { BILLING_PLANS } from "@/lib/billing.config";
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
  const [pending, setPending] = useState<string | null>(null); // plan key being purchased
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [alreadyPaid, setAlreadyPaid] = useState(false);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    fetch("/api/billing/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAlreadyPaid(Boolean(d?.paid)))
      .catch(() => {});
  }, [authStatus]);

  async function handleSelect(planKey: string) {
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
      if (!res.ok) throw new Error(`Couldn't start checkout (${res.status}).`);
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
        name: "KidGemini",
        description: `${order.planLabel} plan`,
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
            setStatus("success");
            setMessage("Payment successful — thank you! 🎉");
            setAlreadyPaid(true);
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

  if (authStatus === "loading") {
    return <div className="h-full w-full bg-white" aria-busy="true" />;
  }

  if (authStatus === "unauthenticated") {
    return (
      <main className="flex h-full w-full flex-col items-center justify-center gap-4 bg-white p-6 text-center">
        <h1 className="text-2xl font-semibold text-neutral-800">Sign in to upgrade</h1>
        <p className="text-sm text-neutral-600">You need an account to manage a subscription.</p>
        <button
          onClick={() => signIn("google")}
          className="rounded-full bg-neutral-800 px-5 py-3 text-base font-medium text-white hover:bg-neutral-700"
        >
          🔆 Sign in with Google
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col items-center px-6 py-12 text-center">
      <a href="/" className="self-start text-sm text-neutral-500 hover:text-neutral-700">
        ← Back to chat
      </a>
      <h1 className="mt-6 text-3xl font-bold text-neutral-900">Go premium ✨</h1>
      <p className="mt-2 max-w-md text-sm text-neutral-600">
        Support KidGemini and keep the fun going. Pick a plan below.
      </p>

      {alreadyPaid && (
        <p className="mt-6 rounded-kid bg-green-50 px-4 py-3 text-sm font-medium text-green-700">
          You have an active plan — thank you! 💚
        </p>
      )}

      <div className="mt-8 flex flex-col items-stretch justify-center gap-6 sm:flex-row">
        {BILLING_PLANS.map((plan) => (
          <PlanCard
            key={plan.key}
            plan={plan}
            highlight={plan.key === "annual"}
            busy={pending === plan.key}
            onSelect={() => handleSelect(plan.key)}
          />
        ))}
      </div>

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
