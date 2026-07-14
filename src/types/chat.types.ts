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

/** Gemini's real billed token counts for one call (usageMetadata). `prompt`
 *  INCLUDES `cached` — Gemini reports cache hits as a subset of the prompt. */
export interface TokenUsage {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedTokens: number;
}

/** One streamed piece of a model reply: answer text, a thought summary
 *  (builder turns, includeThoughts) that feeds the kid-facing planning line —
 *  thoughts are never part of the answer — a `restart`: the previous
 *  model died mid-answer and a fallback is now producing a FRESH reply, so
 *  everything streamed before it must be wiped (owner decision 2026-07-13) —
 *  or a final `usage` chunk carrying the real billed token counts (2026-07-14). */
export interface StreamChunk {
  kind: "delta" | "thought" | "restart" | "usage";
  text: string;
  /** Present on kind:"usage" only. */
  usage?: TokenUsage;
  /** kind:"usage" only: the model that ACTUALLY served the reply — under the
   *  fallback chain / hedge race this can differ from the configured primary,
   *  and each model bills at its own rate. */
  model?: string;
}

/** Any conversational model is a ChatModel (swappable / mockable). */
export interface ChatModel {
  /** Returns the model's draft answer. Caller is responsible for the safety gate. */
  reply(input: { history: ChatMessage[]; message: string; image?: ImageAttachment }): Promise<{
    text: string;
    artifactHtml?: string;
  }>;
}
