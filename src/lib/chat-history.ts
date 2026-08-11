// Validation for client-submitted conversations (server-side history writes).
// Fail-closed: anything malformed returns null and the write is rejected —
// the store must never hold shapes the UI can't render. Pure, no deps.

import type { ChatMessage, Conversation } from "@/types/chat.types";

const MAX_ID = 100;
export const MAX_TITLE = 200;
const MAX_MESSAGES = 500;
/** A single game's HTML (with the injected asset runtime, import maps,
 *  AR_ASSETS tables) can run 100-300KB, and — by owner decision — EVERY
 *  edit's reply keeps its own full snapshot ("the previous version is
 *  available in the chat window" is the rollback story). 2MB (the original
 *  cap) silently rejected a realistic ~30-edit session (2026-08-11 incident:
 *  a morning of real edits never reached the server — every write-through
 *  PUT 400'd from the moment the conversation crossed the old cap onward,
 *  with no user-visible error). 20MB covers roughly 60-100 such edits;
 *  raising a fixed cap is a stopgap, not a structural fix — a long enough
 *  session will eventually hit ANY fixed cap as long as every version is
 *  kept inline. See docs/BUG-FIX-LOG.md same date for the open follow-up
 *  question (externalize old artifacts vs. bound the rollback window). */
export const MAX_CONVO_BYTES = 20_000_000;
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
  const convo: Conversation = {
    id: c.id, title: c.title || "New chat", messages,
    // Preserve the surface tag (PRD-BIBLE-TEACHER) so a bible-teacher thread
    // round-trips into its own workspace; anything but the known value drops to
    // the kid default (fail safe — never leak a teacher chat into the kid list).
    ...(c.workspace === "bible-teacher" ? { workspace: "bible-teacher" as const } : {}),
    // Preserve the edit-a-launched-game binding (chat ↔ published slug) so a
    // cross-device restore still publishes to the same subdomain. Validated to
    // the platform slug shape; anything else is dropped, not rejected.
    ...(typeof c.editSlug === "string" && /^[a-z0-9-]{2,40}$/.test(c.editSlug) ? { editSlug: c.editSlug } : {}),
    // Preserve the pin (owner ask 2026-08-06) so a device's write-through PUT
    // doesn't strip what its own local state carries. The server's pinnedAt
    // COLUMN is canonical (set via PATCH; upsert never writes it) — this only
    // keeps the client-side round-trip honest.
    ...(typeof c.pinnedAt === "number" ? { pinnedAt: c.pinnedAt } : {}),
  };
  if (JSON.stringify(convo).length > MAX_CONVO_BYTES) return null;
  return convo;
}
