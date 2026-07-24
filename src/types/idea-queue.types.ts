// Idea Queue (docs/PRD-IDEA-QUEUE.md): ideas typed WHILE Ari is still building.
// Kept per conversation on `Conversation.queuedIdeas`, so they persist through a
// reload with the chat itself (chat-store + the server write-through).

export interface QueuedIdea {
  id: string;
  /** Exactly what the kid typed — editable while it waits, sent verbatim. */
  text: string;
  createdAt: number;
}
