// One-time Idea Bag → Idea Queue migration (docs/PRD-IDEA-QUEUE-V2.md §5).
// v1 kept spoken ideas in their own localStorage bucket ("kidgemini:ideas:v1");
// v2 has one line per conversation. On the first v2 load, each conversation's
// still-bagged ideas become `tweak` rows on its queue and the old key is
// removed — so the migration can never double-run, and a downgrade can never
// resurrect already-migrated ideas.
//
// Pure functions, storage injected, never throws (chat-store contract).

import { MAX_QUEUED } from "./idea-queue";
import type { QueuedIdea } from "@/types/idea-queue.types";

const BAG_KEY = "kidgemini:ideas:v1";

/** Minimal v1 shape — idea-bag.ts is gone, so the reader lives here with the
 *  same validation the old loadIdeas did. Only `bagged` rows are live intent. */
interface LegacyIdeaRecord {
  id: string;
  gameConvoId: string;
  text: string;
  createdAt: number;
  status: string;
}

/** Read-and-clear the v1 bag. Returns bagged texts per conversation (oldest
 *  first — the order they'd have been bulleted in), or null if there's nothing
 *  to migrate. The key is removed even when the payload is junk: a corrupt bag
 *  has no recoverable intent, and leaving it would re-parse forever. */
export function takeBagForMigration(storage: Storage): Record<string, string[]> | null {
  try {
    const raw = storage.getItem(BAG_KEY);
    if (!raw) return null;
    storage.removeItem(BAG_KEY);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const bagged = parsed
      .filter(
        (i): i is LegacyIdeaRecord =>
          typeof i === "object" &&
          i !== null &&
          typeof (i as LegacyIdeaRecord).gameConvoId === "string" &&
          typeof (i as LegacyIdeaRecord).text === "string" &&
          typeof (i as LegacyIdeaRecord).createdAt === "number" &&
          (i as LegacyIdeaRecord).status === "bagged",
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!bagged.length) return null;
    const byConvo: Record<string, string[]> = {};
    for (const r of bagged) (byConvo[r.gameConvoId] ??= []).push(r.text);
    return byConvo;
  } catch {
    try {
      storage.removeItem(BAG_KEY);
    } catch {
      /* private mode — nothing to clean anyway */
    }
    return null;
  }
}

/** Fold migrated texts into a conversation's queue as `tweak` rows: one row
 *  per text while slots remain, overflow merged into the FINAL tweak row (one
 *  monster row is fine — it drains as one bundle, which is exactly what the
 *  old ✨ button would have sent). Documented exception (PRD v2 §5): a queue
 *  already full of `build` rows drops the texts — with v1's queue and bag
 *  having shipped a day apart, that device state is theoretical. */
export function foldTweaksIntoQueue(
  queue: QueuedIdea[],
  texts: string[],
  opts: { now: number; idFor?: (n: number) => string },
): QueuedIdea[] {
  if (!texts.length) return queue;
  const idFor = opts.idFor ?? (() => crypto.randomUUID());
  const slots = Math.max(0, MAX_QUEUED - queue.length);
  const asRows = texts.slice(0, slots);
  const overflow = texts.slice(slots);
  let next: QueuedIdea[] = [
    ...queue,
    ...asRows.map((text, n) => ({ id: idFor(n), text, kind: "tweak" as const, createdAt: opts.now })),
  ];
  if (overflow.length) {
    const last = next.at(-1);
    if (last?.kind === "tweak") {
      next = next.map((i) => (i.id === last.id ? { ...i, text: [i.text, ...overflow].join("; ") } : i));
    } else {
      console.warn(`[idea-migrate] dropped ${overflow.length} bagged idea(s): queue full of builds`);
    }
  }
  return next;
}
