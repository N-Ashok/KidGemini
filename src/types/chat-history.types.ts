// Server-side chat history (TECH_DEBT #26): conversations keyed by the same
// identity as usage_events (user:<email> or guest:<cookie-uuid>).

import type { Conversation } from "./chat.types";

/** Sidebar-weight row: no message payloads (those can be ~200KB per game chat). */
export interface ConvoSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ChatHistoryStore {
  /** Insert or update; fail-closed on ownership (a foreign id is ignored). */
  upsert(userId: string, convo: Conversation, now: number): void;
  /** One-time device migration; idempotent. Returns how many were written. */
  bulkUpsert(userId: string, convos: Conversation[], now: number): number;
  /** Newest-first summaries. `before` = the LAST row of the prior page —
   *  a composite (updatedAt, id) cursor, so rows sharing a timestamp
   *  (rapid same-ms saves) are never skipped. */
  list(userId: string, limit: number, before?: { updatedAt: number; id: string }): ConvoSummary[];
  /** Full conversation, or null when absent OR owned by someone else. */
  get(userId: string, id: string): Conversation | null;
}
