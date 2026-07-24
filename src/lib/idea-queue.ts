// Idea Queue v2 (docs/PRD-IDEA-QUEUE-V2.md): ONE line for every idea a kid has
// while Ari is busy. v1 gave typed ideas a queue and spoken ideas a separate
// "bag" with different rules; v2 unifies them — typed rows (`build`) drain one
// per turn, spoken rows (`tweak`) bundle consecutive runs into one turn.
//
// Pure functions, no React/Next imports (CLAUDE.md §4). The queue lives on the
// Conversation, so chat-store + the server write-through persist it for free.

import type { QueueHold, QueuedIdea, QueuedIdeaKind } from "@/types/idea-queue.types";

/** How many ideas can wait at once. Small on purpose: the line is meant to be
 *  readable at a glance by a 7-year-old, and every queued row is (at most) a
 *  paid model turn that will run unattended — bundling means it's often less.
 *  At the cap the composer refuses the new idea and says so — it never
 *  silently drops the one the kid typed first. */
export const MAX_QUEUED = 5;

/** Idle tweaks wait this long for the kid's NEXT thought before sending
 *  (PRD v2 §3.3): a kid speaking three ideas in a row must get one bundled
 *  turn, not the first thought built alone the instant it lands. Builds
 *  (typed, deliberate) still send immediately. */
export const TWEAK_SETTLE_MS = 4000;

/** Kid-voiced opener of a bundled tweak message (moved from idea-bag.ts —
 *  same string, so old chat bubbles and prompt behavior are unchanged). */
export const IDEA_BUNDLE_LABEL = "Here are my ideas from playing:";

export function enqueueIdea(
  queue: QueuedIdea[],
  text: string,
  opts: { id?: string; now?: number; kind?: QueuedIdeaKind } = {},
): QueuedIdea[] {
  const trimmed = text.trim();
  if (!trimmed || !canQueue(queue)) return queue;
  return [
    ...queue,
    {
      id: opts.id ?? crypto.randomUUID(),
      text: trimmed,
      kind: opts.kind ?? "build",
      createdAt: opts.now ?? Date.now(),
    },
  ];
}

export function canQueue(queue: QueuedIdea[]): boolean {
  return queue.length < MAX_QUEUED;
}

/** The 🎤 mic path (PRD v2 §3.4). A spoken idea has no composer keeping its
 *  text on refusal, so at the cap it MERGES into a trailing tweak row instead
 *  of vanishing — refusal ("refused") happens only when the last row is a
 *  build (the mic bar then says why and keeps the transcript on screen). */
export function enqueueTweak(
  queue: QueuedIdea[],
  text: string,
  opts: { id?: string; now?: number } = {},
): { queue: QueuedIdea[]; outcome: "queued" | "merged" | "refused" } {
  const trimmed = text.trim();
  if (!trimmed) return { queue, outcome: "refused" };
  if (canQueue(queue)) {
    return { queue: enqueueIdea(queue, trimmed, { ...opts, kind: "tweak" }), outcome: "queued" };
  }
  const last = queue.at(-1);
  if (last?.kind === "tweak") {
    return {
      queue: queue.map((i) => (i.id === last.id ? { ...i, text: `${i.text}; ${trimmed}` } : i)),
      outcome: "merged",
    };
  }
  return { queue, outcome: "refused" };
}

/** ✏️ Fix a waiting idea in place — it keeps its turn and its kind. An edit
 *  that empties the text is a no-op, not a delete: ✕ is the only removal path. */
export function updateQueuedIdea(queue: QueuedIdea[], id: string, text: string): QueuedIdea[] {
  const trimmed = text.trim();
  if (!trimmed) return queue;
  return queue.map((i) => (i.id === id ? { ...i, text: trimmed } : i));
}

/** ✕ — the kid changed their mind about this one. */
export function removeQueuedIdea(queue: QueuedIdea[], id: string): QueuedIdea[] {
  return queue.filter((i) => i.id !== id);
}

/** The single chat message a tweak run sends. Empty list → "" (don't send). */
export function composeIdeaBundle(texts: string[]): string {
  if (!texts.length) return "";
  return `${IDEA_BUNDLE_LABEL}\n${texts.map((t) => `- ${t}`).join("\n")}`;
}

/** Pop one SEND UNIT off the front of the line (PRD v2 §3.2):
 *  - front `build` → that one row, message verbatim.
 *  - front `tweak` → the maximal consecutive tweak run, composed into ONE
 *    bundled message (rule 6: a tweak run must never cost one turn per row).
 *  Rows leave the line before the send, so a re-render can't fire them twice. */
export function takeNextSend(queue: QueuedIdea[]): {
  message: string;
  taken: QueuedIdea[];
  rest: QueuedIdea[];
  isTweakBundle: boolean;
} {
  if (!queue.length) return { message: "", taken: [], rest: [], isTweakBundle: false };
  if (queue[0]!.kind === "build") {
    return { message: queue[0]!.text, taken: [queue[0]!], rest: queue.slice(1), isTweakBundle: false };
  }
  let n = 0;
  while (n < queue.length && queue[n]!.kind === "tweak") n++;
  const taken = queue.slice(0, n);
  return {
    message: composeIdeaBundle(taken.map((i) => i.text)),
    taken,
    rest: queue.slice(n),
    isTweakBundle: true,
  };
}

/** What the drain should do as state changes — the one place to reason about
 *  (and test) the race, replacing v1's `queueSendAction`:
 *  - `wait`   — nothing queued, or a turn is still building.
 *  - `hold`   — a QueueHold is set; the UI is asking the kid.
 *  - `send`   — go: pop `takeNextSend` and fire it.
 *  - `settle` — front is a fresh idle tweak; re-check in `waitMs` (§3.3).
 *  `lastEnqueueAt: 0` means "unknown / Send now ▶" and never settles. */
export function drainDecision(args: {
  queue: QueuedIdea[];
  busy: boolean;
  hold: QueueHold;
  now: number;
  lastEnqueueAt: number;
}): { action: "wait" | "hold" | "send" | "settle"; waitMs?: number } {
  if (!args.queue.length) return { action: "wait" };
  if (args.hold) return { action: "hold" };
  if (args.busy) return { action: "wait" };
  if (args.queue[0]!.kind === "tweak" && args.lastEnqueueAt > 0) {
    const elapsed = args.now - args.lastEnqueueAt;
    if (elapsed < TWEAK_SETTLE_MS) return { action: "settle", waitMs: TWEAK_SETTLE_MS - elapsed };
  }
  return { action: "send" };
}

/** A deliberate kid action (a send, a new idea) landed — what happens to the
 *  hold (PRD v2 §3.5)? A "restored" hold clears (they're clearly present); a
 *  "failed" hold KEEPS ASKING — only the explicit "Yes — keep going ▶" clears
 *  it. This asymmetry is the fix for v1's silent-resume trap. */
export function holdAfterKidAction(hold: QueueHold): QueueHold {
  return hold === "restored" ? null : hold;
}

/** Persisted chats are just JSON on a device — validate before trusting them
 *  (a queued row auto-sends). v1 rows carry no `kind` → "build"; an unknown
 *  kind is dropped, never guessed. */
export function sanitizeQueue(value: unknown): QueuedIdea[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (i): i is QueuedIdea & { kind?: unknown } =>
        typeof i === "object" &&
        i !== null &&
        typeof (i as QueuedIdea).id === "string" &&
        typeof (i as QueuedIdea).text === "string" &&
        typeof (i as QueuedIdea).createdAt === "number" &&
        ((i as QueuedIdea).kind === undefined || ["build", "tweak"].includes((i as QueuedIdea).kind)),
    )
    .map((i) => ({ id: i.id, text: i.text, createdAt: i.createdAt, kind: (i.kind as QueuedIdeaKind) ?? "build" }))
    .slice(0, MAX_QUEUED);
}
