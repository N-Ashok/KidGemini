// Sparks receipt for one chat turn (docs/2026-08-27_PRD_SparksPage.md §3).
//
// The chat route fires each debit (billSparks) without awaiting it — a Sparks
// hiccup must never slow a kid's turn. But the platform's answer carries what
// it charged and the new balance, and the owner wants both on screen after
// every ask (decision 2026-08-27). So AFTER the done frame has gone out, the
// route waits a bounded moment for whatever answers have landed and emits one
// `sparks` frame. Slow platform ⇒ no frame, never a delay.
//
// Scale ceiling: a turn's fan-out LOSERS (kind:"fallback") are billed after
// the response has streamed, so they are not in this receipt — the parent
// statement is the authoritative number. Revisit if losers become common
// (TECH_DEBT: sparks receipt under-reports on hedge-race turns).

export interface SparksDebitReceipt {
  /** Whole Sparks the platform charged for this one debit. */
  charged: number;
  /** Balance after this debit. */
  balance: number;
}

export interface SparksTurnReceipt {
  charged: number;
  balance: number;
}

export const DEFAULT_SPARKS_RECEIPT_WAIT_MS = 2500;

export function sparksReceiptWaitMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SPARKS_RECEIPT_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SPARKS_RECEIPT_WAIT_MS;
}

/** Sum every debit answer that lands within `waitMs`; balance = the last one.
 *  Null when nothing landed (guest, safety-only turn, platform silent). */
export async function settleSparksReceipt(
  debits: ReadonlyArray<Promise<SparksDebitReceipt | null>>,
  waitMs: number,
): Promise<SparksTurnReceipt | null> {
  if (debits.length === 0) return null;
  const landed: SparksDebitReceipt[] = [];
  const tracked = debits.map((p) =>
    p.then((r) => { if (r) landed.push(r); }, () => { /* a failed debit is bookkeeping, not the kid's problem */ }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(tracked),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
  ]);
  if (timer) clearTimeout(timer);
  const last = landed[landed.length - 1];
  if (!last) return null;
  return { charged: landed.reduce((s, r) => s + r.charged, 0), balance: last.balance };
}
