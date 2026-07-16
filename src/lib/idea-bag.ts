// Idea Bag (docs/PRD-IDEA-BUTTON.md): spoken thoughts captured while playing,
// bundled into ONE chat message on "✨ Make my game better!". Device-local like
// chat-store (text only — audio never exists; the browser transcribes live).
// Pure functions: storage injected, never throws. Repo pattern: logic lives
// here, components stay presentational.

import type { IdeaRecord } from "@/types/idea-bag.types";

const KEY = "kidgemini:ideas:v1";
/** Per-game cap: beyond this the OLDEST bagged idea is dropped — capture must
 *  never block mid-play, and a 50-idea wish-list already exceeds one bundle. */
export const MAX_BAGGED_PER_CONVO = 50;
/** Total record cap (bagged + sent + discarded) — localStorage is shared with
 *  chats; sent/discarded records are analytics history, safe to prune oldest. */
export const MAX_TOTAL_RECORDS = 400;
/** Kid-voiced opener of the bundled chat message. */
export const IDEA_BUNDLE_LABEL = "Here are my ideas from playing:";

export function addIdea(
  ideas: IdeaRecord[],
  gameConvoId: string,
  text: string,
  opts: { id?: string; now?: number } = {},
): IdeaRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return ideas;
  const record: IdeaRecord = {
    id: opts.id ?? crypto.randomUUID(),
    gameConvoId,
    text: trimmed,
    createdAt: opts.now ?? Date.now(),
    source: "voice",
    status: "bagged",
  };
  let next = [...ideas, record];

  // Per-convo bagged cap: drop the oldest bagged idea of THIS game.
  const bagged = baggedFor(next, gameConvoId);
  if (bagged.length > MAX_BAGGED_PER_CONVO) {
    const oldest = bagged[0]!;
    next = next.filter((i) => i.id !== oldest.id);
  }

  // Total prune: oldest non-bagged first (bagged ideas are live kid intent).
  while (next.length > MAX_TOTAL_RECORDS) {
    const victim =
      [...next].sort((a, b) => a.createdAt - b.createdAt).find((i) => i.status !== "bagged") ??
      [...next].sort((a, b) => a.createdAt - b.createdAt)[0]!;
    next = next.filter((i) => i.id !== victim.id);
  }
  return next;
}

/** Bagged ideas of one game, oldest first — the order they'll be bulleted in. */
export function baggedFor(ideas: IdeaRecord[], gameConvoId: string): IdeaRecord[] {
  return ideas
    .filter((i) => i.gameConvoId === gameConvoId && i.status === "bagged")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 🗑 / ✕ — record kept as `discarded` (feeds the speech-accuracy signal). */
export function discardIdea(ideas: IdeaRecord[], id: string): IdeaRecord[] {
  return ideas.map((i) => (i.id === id ? { ...i, status: "discarded" as const } : i));
}

/** ✏️ Fix a typo on an already-bagged idea (2026-07-16) — editable directly in
 *  the Idea Bag panel's list, no separate edit-mode step. An edit that empties
 *  the text is a no-op, not a silent delete — 🗑 discard is the only deletion
 *  path (same trim-or-noop rule as `addIdea`). Only `bagged` records are live
 *  kid intent; `sent`/`discarded` are historical and not editable here. */
export function updateIdeaText(ideas: IdeaRecord[], id: string, text: string): IdeaRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return ideas;
  return ideas.map((i) => (i.id === id && i.status === "bagged" ? { ...i, text: trimmed } : i));
}

/** On a SUCCESSFUL generation only: the whole bag of this game went out in
 *  chat message `messageId`. Failure paths never call this — ideas stay bagged. */
export function markSent(ideas: IdeaRecord[], gameConvoId: string, messageId: string): IdeaRecord[] {
  return ideas.map((i) =>
    i.gameConvoId === gameConvoId && i.status === "bagged"
      ? { ...i, status: "sent" as const, sentInMessageId: messageId }
      : i,
  );
}

/** The single chat message the ✨ button sends. Empty bag → "" (don't send). */
export function composeIdeaBundle(texts: string[]): string {
  if (!texts.length) return "";
  return `${IDEA_BUNDLE_LABEL}\n${texts.map((t) => `- ${t}`).join("\n")}`;
}

export function saveIdeas(storage: Storage, ideas: IdeaRecord[]): void {
  try {
    storage.setItem(KEY, JSON.stringify(ideas));
  } catch {
    /* quota/private mode — capture keeps working this session, just not persisted */
  }
}

export function loadIdeas(storage: Storage): IdeaRecord[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (i): i is IdeaRecord =>
        typeof i === "object" &&
        i !== null &&
        typeof (i as IdeaRecord).id === "string" &&
        typeof (i as IdeaRecord).gameConvoId === "string" &&
        typeof (i as IdeaRecord).text === "string" &&
        typeof (i as IdeaRecord).createdAt === "number" &&
        ["bagged", "sent", "discarded"].includes((i as IdeaRecord).status),
    );
  } catch {
    return [];
  }
}
