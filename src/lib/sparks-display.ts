import type { ChatMessage } from "@/types/chat.types";
// Sparks page numbers (docs/2026-08-27_PRD_SparksPage.md §4).
// Owner decisions 2026-08-27: everyone sees them; whole Sparks ("rounding
// yes"); receipts AFTER the ask (an estimate BEFORE is scoped for later).

/** Whole Sparks for display. A non-zero charge never rounds to 0 (a paid ask
 *  is never shown as free); past 10k it compacts ("12k"). */
export function formatSparks(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return Math.max(1, Math.round(n)).toLocaleString("en-US");
}

/** What this chat has used so far (sidebar row) — the sum of receipts on its replies. */
export function chatSparksTotal(messages: ReadonlyArray<ChatMessage>): number {
  return messages.reduce((s, m) => s + (m.role === "assistant" && typeof m.sparks === "number" ? m.sparks : 0), 0);
}

export interface SparksSummary {
  /** Available now (the ledger balance). */
  balance: number | null;
  /** Everything ever spent (sum of debits). */
  used: number | null;
  /** Everything ever received (grants, coupons, rewards, purchases). */
  added: number | null;
}

/** Available / used / added from the platform's parent statement
 *  ({ balance, transactions[{amount}] }). Malformed ⇒ nulls, never NaN. */
export function summarizeStatement(data: unknown): SparksSummary {
  const d = data as { balance?: unknown; transactions?: unknown } | null;
  const balance = d && typeof d.balance === "number" && Number.isFinite(d.balance) ? d.balance : null;
  if (!d || !Array.isArray(d.transactions)) return { balance, used: null, added: null };
  let used = 0, added = 0;
  for (const t of d.transactions as { amount?: unknown }[]) {
    const a = typeof t?.amount === "number" && Number.isFinite(t.amount) ? t.amount : 0;
    if (a < 0) used -= a; else added += a;
  }
  return { balance, used, added };
}
