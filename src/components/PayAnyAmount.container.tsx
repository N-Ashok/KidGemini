"use client";
// Pay-any-amount page (2026-07-24). A signed-in user types an amount and pays it
// via Razorpay Checkout — a top-up / donation, not a plan. Same three-step flow
// as the upgrade page:
//   1. POST /api/billing/order { amountPaise } → { orderId, keyId, amount, currency }
//   2. open Razorpay Checkout with that order
//   3. on success, POST /api/billing/verify (the webhook is the source of truth)
// The amount is validated on the SERVER; the client help below is convenience only.
// The key SECRET never reaches here — only the publishable keyId, per-order from the server.

import { useState } from "react";
import { signIn, useSession } from "@/lib/useAriantraSession";
import {
  rupeesToPaise,
  validateCustomAmountPaise,
  CUSTOM_AMOUNT_MIN_PAISE,
  CUSTOM_AMOUNT_MAX_PAISE,
} from "@/lib/billing.config";

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
const MIN_RUPEES = CUSTOM_AMOUNT_MIN_PAISE / 100;
const MAX_RUPEES = CUSTOM_AMOUNT_MAX_PAISE / 100;

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

const inr = new Intl.NumberFormat("en-IN");

export function PayAnyAmount() {
  const { status: authStatus, data: session } = useSession();
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  // Client-side echo of the server rule — friendly message before a round trip.
  // The server (validateCustomAmountPaise) stays the authority.
  const paise = rupeesToPaise(amount);
  const validPaise = paise !== null ? validateCustomAmountPaise(paise) : null;
  const canPay = validPaise !== null && !pending;

  async function handlePay() {
    if (validPaise === null) {
      setStatus("error");
      setMessage(`Enter an amount between ₹${inr.format(MIN_RUPEES)} and ₹${inr.format(MAX_RUPEES)}.`);
      return;
    }
    setStatus("starting");
    setMessage("");
    setPending(true);
    try {
      const Razorpay = await loadCheckout();
      const res = await fetch("/api/billing/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountPaise: validPaise }),
      });
      if (!res.ok) throw new Error(`Couldn't start checkout (${res.status}).`);
      const order = (await res.json()) as {
        orderId: string;
        amount: number;
        currency: string;
        keyId: string;
      };

      const rzp = new Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: "Ariantra",
        description: "Payment",
        prefill: { email: session?.user?.email ?? undefined, name: session?.user?.name ?? undefined },
        theme: { color: "#262626" },
        modal: { ondismiss: () => setPending(false) },
        handler: async (resp) => {
          try {
            const v = await fetch("/api/billing/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(resp),
            });
            if (!v.ok) throw new Error("Payment could not be verified.");
            setStatus("success");
            setMessage(`Thank you! Your payment of ₹${inr.format(validPaise / 100)} went through. 🎉`);
            setAmount("");
          } catch {
            // Webhook is the source of truth, so it may still be recorded server-side.
            setStatus("error");
            setMessage("Payment received — we're confirming it. If anything looks off, contact support.");
          } finally {
            setPending(false);
          }
        },
      });
      rzp.open();
    } catch (err) {
      setStatus("error");
      setMessage((err as Error).message || "Something went wrong. Please try again.");
      setPending(false);
    }
  }

  if (authStatus === "loading") {
    return <div className="h-full w-full bg-white" aria-busy="true" />;
  }

  if (authStatus === "unauthenticated") {
    return (
      <main className="flex h-full w-full flex-col items-center justify-center gap-4 bg-white p-6 text-center">
        <h1 className="text-2xl font-semibold text-neutral-800">Sign in to pay</h1>
        <p className="text-sm text-neutral-600">You need an account to make a payment.</p>
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
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col items-center px-6 py-12 text-center">
      <a href="/" className="self-start text-sm text-neutral-500 hover:text-neutral-700">
        ← Back to chat
      </a>
      <h1 className="mt-6 text-3xl font-bold text-neutral-900">Make a payment</h1>
      <p className="mt-2 max-w-sm text-sm text-neutral-600">
        Enter any amount and pay securely. Between ₹{inr.format(MIN_RUPEES)} and ₹{inr.format(MAX_RUPEES)}.
      </p>

      <div className="mt-8 w-full">
        <label htmlFor="pay-amount" className="sr-only">
          Amount in rupees
        </label>
        <div className="flex items-center gap-2 rounded-kid border border-neutral-300 px-4 py-3 focus-within:border-neutral-800">
          <span className="text-xl font-semibold text-neutral-500">₹</span>
          <input
            id="pay-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Amount"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              if (status === "error") setStatus("idle");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canPay) void handlePay();
            }}
            className="w-full bg-transparent text-xl font-semibold text-neutral-900 outline-none"
          />
        </div>
      </div>

      <button
        onClick={() => void handlePay()}
        disabled={!canPay}
        className="mt-6 w-full rounded-full bg-neutral-800 px-5 py-3 text-base font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Opening secure checkout…" : validPaise ? `Pay ₹${inr.format(validPaise / 100)}` : "Pay"}
      </button>

      {message && (
        <p className={`mt-6 text-sm font-medium ${status === "success" ? "text-green-700" : "text-red-600"}`}>
          {message}
        </p>
      )}

      <p className="mt-10 max-w-sm text-xs text-neutral-400">
        Payments are processed securely by Razorpay. A grown-up should complete the payment. 🛡️
      </p>
    </main>
  );
}
