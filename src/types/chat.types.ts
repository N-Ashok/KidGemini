// Chat domain types.

export type ChatRole = "child" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** Optional self-contained HTML game, rendered in the sandboxed ArtifactFrame. */
  artifactHtml?: string;
  /** Name of a file the child attached to this message (shown as a chip). */
  attachmentName?: string;
  createdAt: number;
}

/** A chat thread as the UI holds it (and chat-store persists it). */
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
}

/** Any conversational model is a ChatModel (swappable / mockable). */
export interface ChatModel {
  /** Returns the model's draft answer. Caller is responsible for the safety gate. */
  reply(input: { history: ChatMessage[]; message: string }): Promise<{
    text: string;
    artifactHtml?: string;
  }>;
}
