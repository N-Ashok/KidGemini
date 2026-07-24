// Idea Queue (docs/PRD-IDEA-QUEUE.md): before this, the composer was simply
// dead while Ari was building (`disabled={busy}`) — a kid who thought of the
// next thing had nowhere to put it and had to hold it in their head until the
// game finished. Now the idea goes into a visible FIFO line they can edit or
// drop, and it sends itself when Ari is free.
//
// Pure functions, no React/Next imports (CLAUDE.md §4). The queue lives on the
// Conversation, so chat-store + the server write-through persist it for free.

import type { QueuedIdea } from "@/types/idea-queue.types";

/** How many ideas can wait at once. Small on purpose: the line is meant to be
 *  readable at a glance by a 7-year-old, and every queued idea is a paid model
 *  turn that will run unattended. At the cap the composer refuses the new idea
 *  and says so — it never silently drops the one the kid typed first. */
export const MAX_QUEUED = 5;

export function enqueueIdea(
  queue: QueuedIdea[],
  text: string,
  opts: { id?: string; now?: number } = {},
): QueuedIdea[] {
  const trimmed = text.trim();
  if (!trimmed || !canQueue(queue)) return queue;
  return [
    ...queue,
    { id: opts.id ?? crypto.randomUUID(), text: trimmed, createdAt: opts.now ?? Date.now() },
  ];
}

export function canQueue(queue: QueuedIdea[]): boolean {
  return queue.length < MAX_QUEUED;
}

/** ✏️ Fix a waiting idea in place — it keeps its turn in the line. An edit that
 *  empties the text is a no-op, not a delete: ✕ is the only removal path. */
export function updateQueuedIdea(queue: QueuedIdea[], id: string, text: string): QueuedIdea[] {
  const trimmed = text.trim();
  if (!trimmed) return queue;
  return queue.map((i) => (i.id === id ? { ...i, text: trimmed } : i));
}

/** ✕ — the kid changed their mind about this one. */
export function removeQueuedIdea(queue: QueuedIdea[], id: string): QueuedIdea[] {
  return queue.filter((i) => i.id !== id);
}

/** Pop the front of the line. Removal happens BEFORE the send so the resolver
 *  effect can never fire the same idea twice. */
export function takeNextIdea(queue: QueuedIdea[]): { next: QueuedIdea | null; rest: QueuedIdea[] } {
  if (!queue.length) return { next: null, rest: [] };
  return { next: queue[0]!, rest: queue.slice(1) };
}

/** What the queue should do as the turn state changes:
 *  - `wait`  — nothing queued, or a turn is still building.
 *  - `send`  — Ari just finished cleanly and someone is next in line.
 *  - `hold`  — the last turn was STOPPED or failed; the queue freezes and the
 *              UI asks before sending (owner decision 2026-07-24). Auto-draining
 *              here would stack edits onto a game that may be half-built.
 *
 *  Mirrors `ideaQueueAction` in idea-bag.ts: every send routes through this one
 *  decision so there is a single place to reason about (and test) the race. */
export type QueueSendAction = "send" | "hold" | "wait";
export function queueSendAction(args: {
  hasQueued: boolean;
  busy: boolean;
  paused: boolean;
}): QueueSendAction {
  if (!args.hasQueued) return "wait";
  if (args.paused) return "hold";
  if (args.busy) return "wait";
  return "send";
}

/** Persisted chats are just JSON on a device — validate before trusting them
 *  (same contract as loadIdeas/loadChats: never throw, drop what's malformed). */
export function sanitizeQueue(value: unknown): QueuedIdea[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (i): i is QueuedIdea =>
        typeof i === "object" &&
        i !== null &&
        typeof (i as QueuedIdea).id === "string" &&
        typeof (i as QueuedIdea).text === "string" &&
        typeof (i as QueuedIdea).createdAt === "number",
    )
    .slice(0, MAX_QUEUED);
}
