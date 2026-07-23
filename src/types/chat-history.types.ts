// Server-side chat history (TECH_DEBT #26): conversations keyed by the same
// identity as usage_events (user:<email> or guest:<cookie-uuid>).

import type { Conversation, Workspace } from "./chat.types";

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
  list(userId: string, limit: number, before?: { updatedAt: number; id: string }, workspace?: Workspace): ConvoSummary[];
  /** Full conversation, or null when absent OR owned by someone else. */
  get(userId: string, id: string): Conversation | null;
  /** Guest→account merge on login: reassigns every row owned by `fromUserId`
   *  to `toUserId`. An id the target already owns is left under `fromUserId`
   *  (never overwritten/dropped) rather than picking a winner. Returns how
   *  many rows moved. */
  claim(fromUserId: string, toUserId: string): number;
}
