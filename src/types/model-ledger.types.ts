// Per-request model-decision ledger (owner ask 2026-07-21).
//
// A single chat/build/repair request can fire SEVERAL model calls — the
// streaming hedge races two, the one-shot build chain keeps earlier attempts
// alive as it adds backups. Until now nothing recorded, for one request, HOW
// MANY calls we made, WHY each was made, and WHICH one won: usage_events keeps
// only the winner, and app.log only shows a fallback line when one fired. This
// ledger closes that gap — one structured line per request in
// logs/model-decisions.jsonl (see src/lib/model-ledger.ts) so an issue can be
// identified and traced later.
//
// METADATA ONLY (owner decision 2026-07-21): model/role/timing/outcome + the
// winner + the call count. NOT the response bodies — the winner's body already
// lives in turn_results; saving the LOSERS' bodies is the deferred "saved
// runner-up" variant (PRD-INSTANT-ALTERNATE §1) and carries a memory cost.

/** One model call within a request, recorded when its fate is decided. */
export interface AttemptEvent {
  /** The model id this call went to. */
  model: string;
  /** primary | fallback#N | hedge | backup#N — why this call was made. */
  role: string;
  /** How it ended: "won" | a reason phrase ("overloaded", "model gone
   *  (CHECK CONFIG)", "went silent", "returned nothing", "safety") |
   *  "abandoned" (a racing loser we cancelled). */
  outcome: string;
  /** Elapsed ms since the chain opened when this attempt concluded. */
  atMs: number;
  /** Answer characters produced — winner only (streaming path). */
  chars?: number;
}

/** What the runner hands the caller when the chain settles. The caller merges
 *  request identity (ts/reqId/userId/kind) to form the written DecisionLedger. */
export interface ChainSummary {
  /** Models in the order they would be tried (primary first). */
  chain: string[];
  attempts: AttemptEvent[];
  /** The model that produced the served answer, or null if the request failed. */
  winner: string | null;
}

/** One line in logs/model-decisions.jsonl. */
export interface DecisionLedger extends ChainSummary {
  /** ISO timestamp when the line was written. */
  ts: string;
  /** The request/turn id (client replyId when present). */
  reqId: string;
  /** Identity that made the request (user:<email> / guest:<uuid>). */
  userId?: string;
  /** chat | build | repair — which surface fired the chain. */
  kind: string;
  /** attempts.length — how many model calls this one request made. */
  calls: number;
}
