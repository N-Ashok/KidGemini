// The game currently on screen, as a MESSAGE REFERENCE (never its source) —
// shared by the Community Help ticket (fileHelpTicket) and save & continue
// building (docs/2026-08-01_PRD_SaveContinueBuilding.md), both of which key
// off "which message is this game" rather than the html string itself.

import type { ChatMessage } from "@/types/chat.types";

export function currentGameMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((m) => m.artifactHtml);
}
