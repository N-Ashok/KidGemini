// Tab-close / navigate-away recovery, pure half (BUG-FIX-LOG 2026-07-28).
//
// The server finishes a turn whether or not the browser is still listening
// (api/chat's ndjson producer no-ops its writes after a disconnect and still
// records the result). So a kid who asks for a game and then switches tabs,
// opens another chat in a new tab, or locks the phone has a FINISHED reply
// waiting on the server — the only job left is putting it in the right bubble
// on the way back. These helpers are the decisions in that path; the polling
// lives in turn-resume.ts and the wiring in ChatPanel.container.tsx.

import type { Conversation } from "@/types/chat.types";
import type { TurnOutcome } from "./turn-resume";

/** Which bubble a recovery targets. Matches PendingTurn's shape. */
export interface RecoveryTarget {
  convoId: string;
  replyId: string;
}

/** Marker that lets a note be swapped/re-applied instead of stacking up: every
 *  note below starts with it, and only ONE may be present at a time. */
const NOTE_BADGE = "♻️ ";
const NOTE_MARK = `\n\n---\n${NOTE_BADGE}`;

const WORKING_BODY = "Ari is still finishing this one — it'll pop in here, you can keep looking around ✨";
const LOST_BODY = "That one didn't make it back. Ask me again and I'll redo it!";

export const RECOVERY_WORKING_NOTE = NOTE_MARK + WORKING_BODY;
export const RECOVERY_LOST_NOTE = NOTE_MARK + LOST_BODY;

/** Everything from the note marker on — so a re-applied or swapped note
 *  replaces the previous one rather than appending to it. Also strips a
 *  note that stands alone in an empty bubble (no leading rule, see below). */
function stripNote(text: string): string {
  const at = text.indexOf(NOTE_MARK);
  if (at !== -1) return text.slice(0, at);
  return text.startsWith(NOTE_BADGE) ? "" : text;
}

function patchReply(
  convos: Conversation[],
  target: RecoveryTarget,
  patch: (text: string) => Partial<Conversation["messages"][number]>,
): { convos: Conversation[]; patched: boolean } {
  let patched = false;
  const next = convos.map((c) => {
    if (c.id !== target.convoId) return c;
    if (!c.messages.some((m) => m.id === target.replyId)) return c;
    patched = true;
    return {
      ...c,
      messages: c.messages.map((m) => (m.id === target.replyId ? { ...m, ...patch(m.text) } : m)),
    };
  });
  return { convos: patched ? next : convos, patched };
}

/** Put the server's finished reply into the waiting bubble. `patched: false`
 *  means the bubble isn't here (server-only chat on this device, or the message
 *  is gone) — the caller decides whether to fetch the chat and try again. */
export function applyRecoveredReply(
  convos: Conversation[],
  target: RecoveryTarget,
  reply: { text: string; artifactHtml: string | null },
): { convos: Conversation[]; patched: boolean } {
  return patchReply(convos, target, () => ({
    text: reply.text,
    artifactHtml: reply.artifactHtml ?? undefined,
  }));
}

/** Persists a successful self-heal patch (BUG-FIX-LOG 2026-08-13 — the
 *  browser-only preview repair loop threw its own fix away on every
 *  reload/reopen, so a kid saw the same broken game over and over). `target`
 *  is the SAME { convoId, replyId } shape as recovery — `replyId` names the
 *  game's own assistant message, not necessarily the newest one. Leaves the
 *  message's text (and everything else) untouched — only the artifact
 *  changes, same as a normal build never touches unrelated fields. */
export function applyRepairedArtifact(
  convos: Conversation[],
  target: RecoveryTarget,
  html: string,
): { convos: Conversation[]; patched: boolean } {
  return patchReply(convos, target, () => ({ artifactHtml: html }));
}

/** Tell the kid what's happening in the bubble itself, keeping whatever had
 *  already streamed. Idempotent: safe to call on every poll tick. */
export function noteStillWorking(
  convos: Conversation[],
  target: RecoveryTarget,
  note: string,
): { convos: Conversation[]; patched: boolean } {
  return patchReply(convos, target, (text) => {
    const kept = stripNote(text);
    // Nothing streamed before the drop → the note stands alone, no dangling rule.
    return { text: kept ? kept + note : NOTE_BADGE + note.slice(NOTE_MARK.length) };
  });
}

/** How long a `running` turn stays believable. A turn whose server process was
 *  restarted (deploy, crash) keeps its `running` row until the 24h TTL with
 *  nobody generating — without this bound, every app load would re-poll it and
 *  the kid would keep seeing "still finishing" for a reply that will never
 *  come. Comfortably longer than the slowest observed build. */
export const RECOVERY_MAX_AGE_MS = 15 * 60 * 1000;

/** Whether the device must remember this turn for the NEXT app load too.
 *  Only a `running` turn young enough to still be real does. */
export function keepBookmark(outcome: TurnOutcome, ageMs = 0): boolean {
  return outcome.status === "running" && ageMs < RECOVERY_MAX_AGE_MS;
}
