// Validation for client-submitted conversations (server-side history writes).
// Fail-closed: anything malformed returns null and the write is rejected —
// the store must never hold shapes the UI can't render. Pure, no deps.

import type { ChatMessage, Conversation } from "@/types/chat.types";

const MAX_ID = 100;
const MAX_TITLE = 200;
const MAX_MESSAGES = 500;
/** A game-building chat runs ~200KB with artifacts; 2MB is generous headroom. */
export const MAX_CONVO_BYTES = 2_000_000;
/** Migration cap — a device store holds tens of chats, never hundreds. */
export const MAX_BULK = 200;
export const LIST_DEFAULT = 30;
export const LIST_MAX = 100;

function cleanMessage(input: unknown): ChatMessage | null {
  const m = input as Partial<ChatMessage> | null;
  if (!m || typeof m !== "object") return null;
  if (typeof m.id !== "string" || !m.id || m.id.length > MAX_ID) return null;
  if (m.role !== "child" && m.role !== "assistant") return null;
  if (typeof m.text !== "string") return null;
  if (typeof m.createdAt !== "number") return null;
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
    ...(typeof m.artifactHtml === "string" ? { artifactHtml: m.artifactHtml } : {}),
    ...(typeof m.attachmentName === "string" ? { attachmentName: m.attachmentName } : {}),
    ...(m.fromIdeaBag === true ? { fromIdeaBag: true } : {}),
  };
}

/** Whitelist-validate a conversation. Null = reject the write (fail closed). */
export function sanitizeConversation(input: unknown): Conversation | null {
  const c = input as Partial<Conversation> | null;
  if (!c || typeof c !== "object") return null;
  if (typeof c.id !== "string" || !c.id || c.id.length > MAX_ID) return null;
  if (typeof c.title !== "string" || c.title.length > MAX_TITLE) return null;
  if (!Array.isArray(c.messages) || c.messages.length === 0 || c.messages.length > MAX_MESSAGES) return null;
  const messages: ChatMessage[] = [];
  for (const raw of c.messages) {
    const m = cleanMessage(raw);
    if (!m) return null;
    messages.push(m);
  }
  const convo: Conversation = { id: c.id, title: c.title || "New chat", messages };
  if (JSON.stringify(convo).length > MAX_CONVO_BYTES) return null;
  return convo;
}
