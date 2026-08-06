// Server-side chat history (TECH_DEBT #26): conversations keyed by the same
// identity as usage_events (user:<email> or guest:<cookie-uuid>).

import type { ChatMessage, Conversation, Workspace } from "./chat.types";

/** Sidebar-weight row: no message payloads (those can be ~200KB per game chat). */
export interface ConvoSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Pin (owner ask 2026-08-06, sidebar ⋮ menu): timestamp when pinned, null/
   *  absent otherwise. The client sorts pinned-first (chat-organize.ts) — the
   *  SQL list order stays pure recency so cursor pagination is untouched. */
  pinnedAt?: number | null;
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
  /** SOFT delete (owner ask 2026-07-26): hides the chat from this account's
   *  view (list + get) — the row itself stays in the system (safety review,
   *  recoverability). Fail-closed on ownership: a foreign or unknown id is a
   *  no-op returning false. Idempotent: a second delete also returns false. */
  softDelete(userId: string, id: string, now: number): boolean;
  /** Rename (owner ask 2026-08-06): title only — deliberately does NOT bump
   *  updatedAt, so fixing an old chat's name never catapults it up Recents.
   *  Fail-closed on ownership and soft-deleted rows; false = nothing changed. */
  rename(userId: string, id: string, title: string): boolean;
  /** Pin/unpin (owner ask 2026-08-06): stamps/clears pinnedAt. Same
   *  fail-closed contract as rename. */
  setPinned(userId: string, id: string, pinned: boolean, now: number): boolean;
  /** Share link (2026-08-06_PRD_ShareConversation.md): set/replace the token,
   *  or null to revoke. Fail-closed like rename/setPinned. */
  setShareToken(userId: string, id: string, token: string | null): boolean;
  /** Owner's view of share state: null = no such visible chat. */
  getShareToken(userId: string, id: string): { shareToken: string | null } | null;
  /** PUBLIC token-only read for the share page — unreachable once revoked or
   *  soft-deleted. */
  getSharedByToken(token: string): { title: string; messages: ChatMessage[]; updatedAt: number } | null;
  /** Guest→account merge on login: reassigns every row owned by `fromUserId`
   *  to `toUserId`. An id the target already owns is left under `fromUserId`
   *  (never overwritten/dropped) rather than picking a winner. Returns how
   *  many rows moved. */
  claim(fromUserId: string, toUserId: string): number;
}
