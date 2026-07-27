// Sparks ⚡ bridge to the platform's partner endpoint (PRD-SPARKS Phase 3,
// platform repo docs/PRD-SPARKS.md). Same server-to-server contract as
// arcade-partner.ts: x-admin-secret header + the kid's raw session JWT in the
// body. The PLATFORM owns the ledger; Ari only reports measured usage and
// renders what comes back. All calls are fail-safe — billing bookkeeping must
// never break a chat turn or a page.

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";
const SPARKS_TIMEOUT_MS = 8000;

export interface SparksUsageEntry {
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached?: number;
  /** Ari's own MODEL_CATALOG cost — the platform trusts and converts it. */
  costUsd?: number;
}

export interface SparksResult {
  status: number;
  data: Record<string, unknown>;
}

async function sparksPost(payload: unknown): Promise<SparksResult> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPARKS_TIMEOUT_MS);
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/studio/partner/sparks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  } catch (err) {
    console.error(`[sparks-bridge] fetch failed: ${(err as Error).message}`);
    return { status: 502, data: { error: "sparks unavailable" } };
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget metered debit for one usage row of a turn. Never throws,
 *  never awaited on the hot path — a Sparks hiccup must not slow a kid's turn.
 *  Idempotency: (replyId, seq) — the platform ignores replays. */
export function billSparks(opts: {
  sessionToken: string;
  replyId: string;
  seq: number;
  kind: string;
  action?: string;
  usage: SparksUsageEntry;
}): void {
  void sparksPost({
    sessionToken: opts.sessionToken,
    debit: {
      turnId: `${opts.replyId}:${opts.kind}:${opts.usage.model}:${opts.seq}`,
      action: opts.action ?? opts.kind,
      usage: [opts.usage],
    },
  }).then((r) => {
    if (r.status !== 200) console.error(`[sparks-bridge] debit rejected (${r.status})`);
  });
}

/** Kid-safe wallet payload (credits-only history, gauge, referral code). */
export function fetchWallet(sessionToken: string): Promise<SparksResult> {
  return sparksPost({ sessionToken, wallet: true });
}

/** Full parent statement (every transaction + exact balance). */
export function fetchParentStatement(sessionToken: string): Promise<SparksResult> {
  return sparksPost({ sessionToken, parentStatement: true });
}

export function redeemCoupon(sessionToken: string, code: string): Promise<SparksResult> {
  return sparksPost({ sessionToken, redeem: { code } });
}

/** Phase 5: credit a Razorpay-paid Sparks pack. Server-to-server (like
 *  arcade-partner.ts's inviteCredit) — the WEBHOOK caller has no live
 *  session to replay, so playerId is passed explicitly (captured by
 *  order/route.ts at order-creation time, when a session WAS live; see
 *  PaymentRecord.playerId). Unlike billSparks, this is AWAITED by the
 *  caller (never fire-and-forget) — a payment already succeeded, so the
 *  caller must know whether the credit landed and decide how to react
 *  (verify degrades gracefully; webhook throws to trigger a Razorpay
 *  retry). razorpayPaymentId is the platform ledger's idempotency key, so
 *  calling this twice for the same payment credits once. */
export function creditPurchase(purchase: {
  playerId: string;
  packKey: string;
  sparks: number;
  amountInr: number;
  razorpayPaymentId: string;
}): Promise<SparksResult> {
  return sparksPost({ purchase });
}

/** Parent-submitted share of the kid's game on Ariantra's social pages. */
export function submitSocialShare(
  sessionToken: string,
  gameSlug: string,
  platform: string,
  url: string,
): Promise<SparksResult> {
  return sparksPost({ sessionToken, socialShare: { gameSlug, platform, url } });
}
