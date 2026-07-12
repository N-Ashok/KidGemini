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
  /** True when this child message is a bundled Idea Bag send (🎒 label in the
   *  bubble) — spoken thoughts captured during play, docs/PRD-IDEA-BUTTON.md. */
  fromIdeaBag?: boolean;
  createdAt: number;
}

/** A chat thread as the UI holds it (and chat-store persists it). */
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
}

/** A picture the child attached for context (base64 payload, no data: prefix).
 *  Guards live in image-attachment.ts — mime allow-list + size cap, fail-closed. */
export interface ImageAttachment {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
}

/** One streamed piece of a model reply: answer text, or a thought summary
 *  (builder turns, includeThoughts) that feeds the kid-facing planning line —
 *  thoughts are never part of the answer. */
export interface StreamChunk {
  kind: "delta" | "thought";
  text: string;
}

/** Any conversational model is a ChatModel (swappable / mockable). */
export interface ChatModel {
  /** Returns the model's draft answer. Caller is responsible for the safety gate. */
  reply(input: { history: ChatMessage[]; message: string; image?: ImageAttachment }): Promise<{
    text: string;
    artifactHtml?: string;
  }>;
}
