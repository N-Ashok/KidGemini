// Types for the Razorpay one-time payment flow. Interfaces first (Dependency Inversion):
// API routes depend on PaymentGateway / PaymentStore, never on Razorpay or SQLite directly.
//
// "Rails only" for now (see docs/PRD.md §8): a captured payment is recorded and the access
// period is stamped, but NO entitlement is enforced yet — every signed-in user stays unlimited.
// Recurring (Razorpay Subscriptions) needs pre-created Plans; this one-time model needs none.

/** A purchasable plan = a one-time charge granting `periodDays` of access. Amounts in paise (₹1 = 100). */
export interface BillingPlan {
  key: string; // "monthly" | "annual"
  label: string; // shown on the plan card
  amountPaise: number; // charge amount in paise
  periodDays: number; // access granted — used when entitlement is wired later
  description: string; // human price line, e.g. "₹699 / month"
}

export type PaymentStatus = "created" | "paid" | "failed";

/** One recorded payment for a user — one row per Razorpay order. */
export interface PaymentRecord {
  id: string;
  userId: string;
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
    planKey: string;
    amountPaise: number;
    currency: string;
    razorpayOrderId: string;
  }): PaymentRecord;
  /** Flip an order to "paid" and stamp the access period. Returns null if the order is unknown. */
  markPaid(razorpayOrderId: string, razorpayPaymentId: string, periodEndsAt: number): PaymentRecord | null;
  /** Idempotency: record `eventId` and return true if new, false if already processed. */
  isNewEvent(eventId: string): boolean;
  getByOrderId(razorpayOrderId: string): PaymentRecord | null;
  latestForUser(userId: string): PaymentRecord | null;
}
