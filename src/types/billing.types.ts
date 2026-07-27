// Types for the Razorpay one-time payment flow. Interfaces first (Dependency Inversion):
// API routes depend on PaymentGateway / PaymentStore, never on Razorpay or SQLite directly.
//
// "Rails only" for now (see docs/PRD.md §8): a captured payment is recorded and the access
// period is stamped, but NO entitlement is enforced yet — every signed-in user stays unlimited.
// Recurring (Razorpay Subscriptions) needs pre-created Plans; this one-time model needs none.

/** A purchasable Sparks top-up (Phase 5 payments) — a one-time charge that
 *  credits `sparks` to the buyer's Platform ledger balance. Amounts in paise
 *  (₹1 = 100). Repeatable: buying a pack twice credits twice, unlike the
 *  superseded yearly-access plans this replaced. */
export interface SparkPack {
  key: string; // "pack120" | "pack200" | "pack500" — public contract, pinned by billing.config.test.ts
  label: string; // shown on the pack card
  amountPaise: number; // charge amount in paise
  sparks: number; // Sparks credited to the Platform ledger on success
  description: string; // human price line, e.g. "₹120 — 12,000 ⚡"
}

export type PaymentStatus = "created" | "paid" | "failed";

/** One recorded payment for a user — one row per Razorpay order. */
export interface PaymentRecord {
  id: string;
  userId: string;
  /** The platform's real ledger key (Phase 5), captured at order-creation
   *  time from the live session — needed so the webhook (no live session)
   *  can still credit the Sparks purchase. Null for pre-migration rows and
   *  the CUSTOM_PLAN_KEY pay-any-amount charge (which credits nothing). */
  playerId: string | null;
  planKey: string;
  amountPaise: number;
  currency: string; // "INR"
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  status: PaymentStatus;
  periodEndsAt: number | null; // ms; set when paid
  createdAt: number;
  updatedAt: number;
}

/** A Razorpay order, narrowed to the fields we use. */
export interface GatewayOrder {
  id: string; // order_xxx
  amount: number; // paise
  currency: string;
}

/** Talks to the payment provider. Concrete impl (RazorpayGateway) is constructed at the edge. */
export interface PaymentGateway {
  /** The publishable key id — safe to hand to the browser for Checkout. */
  readonly keyId: string;
  createOrder(input: {
    amountPaise: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder>;
  /** Verify a Checkout handler response: HMAC(order_id|payment_id, key_secret) === signature. */
  verifyPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  /** Verify a webhook: HMAC(rawBody, webhook_secret) === signature. Fail-closed if no secret. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

/** Persistence boundary for payments (concrete impl injected at the edge). */
export interface PaymentStore {
  /** Record a freshly-created order in the "created" state. */
  create(input: {
    userId: string;
    playerId: string | null;
    planKey: string;
    amountPaise: number;
    currency: string;
    razorpayOrderId: string;
  }): PaymentRecord;
  /** Flip an order to "paid" and stamp the access period. `periodEndsAt` is null
   *  for a custom pay-any-amount charge, which grants no entitlement. Returns
   *  null if the order is unknown. */
  markPaid(
    razorpayOrderId: string,
    razorpayPaymentId: string,
    periodEndsAt: number | null,
  ): PaymentRecord | null;
  /** Idempotency: record `eventId` and return true if new, false if already processed. */
  isNewEvent(eventId: string): boolean;
  getByOrderId(razorpayOrderId: string): PaymentRecord | null;
  /** The user's latest ENTITLING payment (a plan purchase). Custom pay-any-amount
   *  rows are excluded, so a ₹1 donation can neither grant access nor mask a
   *  real plan the user already holds. */
  latestForUser(userId: string): PaymentRecord | null;
}
