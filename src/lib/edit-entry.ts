// Edit-a-launched-game entry (PRD-STUDIO-CHAT-EDIT, revised 2026-07-24 — Ari
// is the editor). Studio's "✏️ Edit in Games-Lab" links to
// /?edit=<slug>&chat=<chatId?> (or /bible-teacher?… for teacher games).
// Resolution, in order: the linked chat if it still exists (local, then
// server) → otherwise seed a fresh chat with the game's live code fetched via
// /api/arcade/edit-source. Pure helpers here; fetching stays in the container.

import type { Conversation, Workspace } from "@/types/chat.types";

/** Same charset/length the platform enforces on slugs (studio-policy). */
const SLUG_RE = /^[a-z0-9-]{2,40}$/;
const MAX_CHAT_ID = 100;

export interface EditEntry {
  slug: string;
  chatId: string | null;
}

/** Parse Studio's deep-link params. Null = not an edit entry (normal load).
 *  Fail closed: a malformed slug drops the whole entry; a malformed chat id
 *  drops just the chat (the seed flow still works). */
export function parseEditEntry(search: string): EditEntry | null {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const slug = (q.get("edit") ?? "").trim();
  if (!SLUG_RE.test(slug)) return null;
  const chat = (q.get("chat") ?? "").trim();
  return { slug, chatId: chat !== "" && chat.length <= MAX_CHAT_ID ? chat : null };
}

/** The same URL with the edit params removed (house rule: no URL jumps —
 *  a reload after arrival must not re-run the entry). Other params survive. */
export function stripEditParams(pathAndSearch: string): string {
  const [path, search = ""] = pathAndSearch.split("?");
  const q = new URLSearchParams(search);
  q.delete("edit");
  q.delete("chat");
  const rest = q.toString();
  return rest ? `${path}?${rest}` : (path ?? "/");
}

export const SEEDING_TEXT = "Getting your game from the Arcade… 🎁";

/** Placeholder chat shown WHILE the game's code is being fetched — progress,
 *  never a blank screen. Bound to the slug from the start so the moment the
 *  code lands, Publish already targets the same subdomain. */
export function seedingConversation(workspace: Workspace, slug: string): Conversation {
  return {
    id: crypto.randomUUID(),
    title: slug,
    editSlug: slug,
    messages: [
      { id: crypto.randomUUID(), role: "assistant", text: SEEDING_TEXT, createdAt: Date.now() },
    ],
    ...(workspace === "bible-teacher" ? { workspace } : {}),
  };
}

/** The code arrived: title the chat after the game and make it playable. */
export function applySeed(convo: Conversation, game: { name: string; html: string }): Conversation {
  return {
    ...convo,
    title: game.name,
    messages: [
      {
        ...convo.messages[0]!,
        text: `Here's your game **${game.name}**, straight from the Arcade! 🚀 It's playing right here. Tell me what you want to change — anything at all!`,
        artifactHtml: game.html,
      },
    ],
  };
}

/** The seed failed: say exactly what to do next (house UX rule — no dead
 *  ends), and DROP the slug binding so a later publish from this chat can't
 *  overwrite a game whose code was never loaded. Copy promises nothing we
 *  can't do (owner rule 2026-07-24: never "coming soon"). */
export function applySeedFailure(
  convo: Conversation,
  args: { reason?: string; signedOut?: boolean },
): Conversation {
  const text = args.signedOut
    ? "I couldn't grab your game because you're not signed in here. Sign in with the same account you use in Studio, then tap the Edit button in Studio again."
    : args.reason === "multi-file"
      ? "This game has many files, so I can't edit it here. You can still update it — re-upload the updated files in Studio."
      : args.reason === "deleted"
        ? "That game was deleted. Restore it in Studio first, then tap Edit again."
        : args.reason === "admin-paused"
          ? "That game is paused for review, so it can't be edited right now. Check Studio for details, or email contact@ariantra.com."
          : "I couldn't get your game from the Arcade just now. Check the internet, then tap the Edit button in Studio to try again.";
  const { editSlug: _dropped, ...rest } = convo;
  return {
    ...rest,
    messages: [{ ...convo.messages[0]!, text, artifactHtml: undefined }],
  };
}
