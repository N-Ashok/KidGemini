// Client-side chat search for the sidebar filter. Pure logic, no React/Next.
// Matches conversation titles and message text; deliberately IGNORES
// artifactHtml — searching generated game source would surface noise matches
// ("div", "function") for chats a kid doesn't associate with that word.

import type { Conversation } from "@/types/chat.types";

/** Case-insensitive substring filter. Empty/whitespace query → all convos. */
export function searchChats(convos: Conversation[], query: string): Conversation[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return convos;
  return convos.filter(
    (c) =>
      c.title.toLowerCase().includes(needle) ||
      c.messages.some((m) => m.text.toLowerCase().includes(needle)),
  );
}
