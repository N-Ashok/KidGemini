// Save & continue building (docs/2026-08-01_PRD_SaveContinueBuilding.md).
// Scope: the in-chat draft (Ari's own sandboxed preview), NOT the
// published/Arcade case (PRD §8, out of scope).

/** One placed object in a build/world game. Deliberately loose beyond
 *  position — a stacking game's block and a "build your universe" game's
 *  building carry different extra fields (color, rotation, type, ...), and
 *  the restore step just hands the whole thing back to the game's own
 *  restore code, which knows its own shape. */
export interface GameSaveObject {
  [key: string]: unknown;
}

/** A distinct build area, keyed by its own id/origin (PRD §3a) — a game
 *  where the player can travel and build in multiple places must save every
 *  area, not just the one the player is standing in when autosave fires. */
export interface GameSaveArea {
  id: string;
  originX: number;
  originZ: number;
  objects: GameSaveObject[];
}

/** The whole persistent world, exactly what the game replies with on a
 *  `ariantra:request-save` postMessage (PRD §3a). */
export interface GameSaveState {
  areas: GameSaveArea[];
}

export interface GameSaveRecord {
  id: string;
  conversationId: string;
  messageId: string;
  userId: string;
  state: GameSaveState;
  createdAt: number;
  updatedAt: number;
}

export interface GameSaveStore {
  /** Insert or update the one save slot for (conversationId, messageId).
   *  Fail-closed on ownership: a foreign id's row is left untouched (no
   *  rows change). Server-side debounced (PRD §3c) — a write landing less
   *  than the debounce window after the prior one for the same message is a
   *  silent no-op. Returns whether this call actually wrote. */
  upsert(
    userId: string,
    input: { conversationId: string; messageId: string; state: GameSaveState },
    now: number,
  ): boolean;
  /** The saved state for one message, or null when absent OR owned by
   *  someone else (fail-closed, same as ChatHistoryStore.get). */
  get(userId: string, messageId: string): GameSaveRecord | null;
  /** Cascade delete — every save row for a conversation, e.g. when the
   *  conversation itself is (soft-)deleted (docs/SCALABILITY_ISSUES.md #8).
   *  Unscoped by userId: only ever called internally, from inside the
   *  already-ownership-checked conversation delete. Returns rows removed. */
  deleteByConversation(conversationId: string): number;
}
