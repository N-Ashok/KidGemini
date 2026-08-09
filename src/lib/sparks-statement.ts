// Parent statement arithmetic (owner report 2026-08-09: "nothing provided the
// details of total sparks used in the sparks management from the last recharge.
// ledger is not clear").
//
// Pure — no React, no fetch (CLAUDE.md §4). The parent card already fetches the
// full append-only statement; the missing piece was never data, it was the
// summary. Nothing here needs a schema change: `sparkwallets` holds only
// { playerId, balance }, but every credit and debit is already in
// `sparktransactions` with an amount and a timestamp.

export interface StatementTxn {
  id: string;
  at: string;
  kind: string;
  amount: number;
  balanceAfter: number;
  meta: Record<string, unknown>;
}

export interface SinceLastRecharge {
  /** Sparks that have LEFT the balance since the recharge (a positive number). */
  spent: number;
  /** Size of that recharge. 0 when we're summarising from the start. */
  added: number;
  /** How many of the debits were builds — `usage_debit` only, so an
   *  adjustment by Ariantra isn't miscounted as the child building something. */
  builds: number;
  /** Kind of the credit we measured from ('purchase', 'admin_grant', …). */
  kind: string | null;
  /** ISO timestamp of that credit, or of the earliest row when `sinceStart`. */
  at: string | null;
  /** True when no credit exists in the statement, so this is "since the
   *  beginning" rather than "since the last top-up". The UI must say which —
   *  a number without its window is the same unclear ledger, relabelled. */
  sinceStart: boolean;
}

/** A recharge is the most recent CREDIT of any kind, not a hardcoded list of
 *  kinds. Deliberate: production has zero `purchase` rows so far and every
 *  balance to date arrived as `admin_grant`, so a purchase-only definition
 *  would summarise nothing for every current user. */
export function summarizeSinceLastRecharge(txns: StatementTxn[]): SinceLastRecharge | null {
  const dated = txns
    .map((t) => ({ t, ms: Date.parse(t.at) }))
    .filter((r) => Number.isFinite(r.ms))
    .sort((a, b) => a.ms - b.ms); // oldest → newest, whatever order we were handed

  if (dated.length === 0) return null;

  let cutIndex = -1;
  for (let i = dated.length - 1; i >= 0; i--) {
    if (dated[i]!.t.amount > 0) {
      cutIndex = i;
      break;
    }
  }

  const sinceStart = cutIndex === -1;
  const recharge = sinceStart ? null : dated[cutIndex]!.t;
  const after = dated.slice(cutIndex + 1).map((r) => r.t);

  let spent = 0;
  let builds = 0;
  for (const t of after) {
    if (t.amount >= 0) continue;
    spent += -t.amount;
    if (t.kind === "usage_debit") builds++;
  }

  return {
    spent,
    added: recharge?.amount ?? 0,
    builds,
    kind: recharge?.kind ?? null,
    at: recharge?.at ?? dated[0]!.t.at,
    sinceStart,
  };
}
