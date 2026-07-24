// Idea Queue (docs/PRD-IDEA-QUEUE-V2.md): every idea a kid has while Ari is
// busy — typed OR spoken — waits in one visible line per conversation, kept on
// `Conversation.queuedIdeas` so it persists through a reload with the chat
// itself (chat-store + the server write-through).

/** Where a queued idea came from decides how it drains (PRD v2 §3.1):
 *  - "build" — typed into the composer. One row = one model turn.
 *  - "tweak" — spoken over the preview via the 🎤 mic tab. Consecutive tweaks
 *    compose into ONE bundled turn (`takeNextSend`) — five spoken thoughts
 *    about the current game must never cost five rebuilds.
 *  Kind is assigned by ORIGIN, never inferred from the text. */
export type QueuedIdeaKind = "build" | "tweak";

export interface QueuedIdea {
  id: string;
  /** Exactly what the kid typed/said — editable while it waits, sent verbatim
   *  (tweaks: verbatim inside the bundle's bullet list). */
  text: string;
  kind: QueuedIdeaKind;
  createdAt: number;
}

/** Why the line is NOT draining (PRD v2 §3.5) — modeling the reason is what
 *  fixes the v1 silent-resume trap (any fresh send un-froze a failed line):
 *  - "restored" — the chat was just opened/switched/reloaded with a line.
 *    Cleared by any deliberate kid action (a send, a new idea) — nothing was
 *    broken, they're clearly present now.
 *  - "failed"   — the last turn was stopped or failed. Cleared ONLY by the
 *    explicit "Yes — keep going ▶"; sends and enqueues leave it asking.
 *  - null       — the line may drain. */
export type QueueHold = "restored" | "failed" | null;
