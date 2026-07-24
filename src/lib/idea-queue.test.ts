// Idea Queue (docs/PRD-IDEA-QUEUE.md): ideas typed WHILE a turn is building
// wait in a FIFO line instead of being lost to a dead composer. The queue is
// kid-visible and editable, drains one at a time on success only, and HOLDS
// (asks) after a stop/failure — never chains an edit onto a broken game.
import { describe, expect, it } from "vitest";
import {
  MAX_QUEUED,
  canQueue,
  enqueueIdea,
  queueSendAction,
  removeQueuedIdea,
  sanitizeQueue,
  takeNextIdea,
  updateQueuedIdea,
} from "./idea-queue";
import type { QueuedIdea } from "@/types/idea-queue.types";

function q(over: Partial<QueuedIdea> = {}): QueuedIdea {
  return { id: "i1", text: "add a dragon boss", createdAt: 1, ...over };
}

describe("enqueueIdea", () => {
  it("appends a trimmed idea to the back of the line (FIFO)", () => {
    const out = enqueueIdea([q({ id: "a", text: "first" })], "  second  ", { id: "b", now: 42 });
    expect(out.map((i) => i.text)).toEqual(["first", "second"]);
    expect(out[1]).toMatchObject({ id: "b", text: "second", createdAt: 42 });
  });

  it("ignores an empty or whitespace-only idea", () => {
    const queue = [q()];
    expect(enqueueIdea(queue, "   ")).toBe(queue);
    expect(enqueueIdea([], "")).toEqual([]);
  });

  it("never grows past the cap — the oldest idea is NOT dropped", () => {
    // Silently dropping the idea a kid typed first would be the worst outcome;
    // the composer refuses the new one instead (canQueue) and says why.
    const full = Array.from({ length: MAX_QUEUED }, (_, n) => q({ id: `i${n}`, text: `idea ${n}` }));
    const out = enqueueIdea(full, "one too many");
    expect(out).toBe(full);
    expect(out.map((i) => i.text)).not.toContain("one too many");
  });

  it("gives every idea its own id", () => {
    const out = enqueueIdea(enqueueIdea([], "a"), "b");
    expect(out[0]!.id).not.toEqual(out[1]!.id);
  });
});

describe("canQueue", () => {
  it("is true below the cap and false at it", () => {
    expect(canQueue([])).toBe(true);
    expect(canQueue(Array.from({ length: MAX_QUEUED - 1 }, () => q()))).toBe(true);
    expect(canQueue(Array.from({ length: MAX_QUEUED }, () => q()))).toBe(false);
  });
});

describe("updateQueuedIdea", () => {
  it("✏️ rewrites the waiting idea in place, trimmed", () => {
    const out = updateQueuedIdea([q({ id: "a" }), q({ id: "b" })], "b", "  make the sky purple ");
    expect(out[1]!.text).toBe("make the sky purple");
    expect(out[0]!.text).toBe("add a dragon boss");
  });

  it("keeps its place in the line (an edit is not a re-queue)", () => {
    const out = updateQueuedIdea([q({ id: "a" }), q({ id: "b" })], "a", "edited");
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("treats an emptied edit as a no-op, not a silent delete", () => {
    // ✕ is the only removal path — same rule as the Idea Bag's updateIdeaText.
    const queue = [q({ id: "a" })];
    expect(updateQueuedIdea(queue, "a", "   ")).toEqual(queue);
  });

  it("ignores an unknown id", () => {
    const queue = [q({ id: "a" })];
    expect(updateQueuedIdea(queue, "nope", "x")).toEqual(queue);
  });
});

describe("removeQueuedIdea", () => {
  it("✕ drops just that idea and closes the gap", () => {
    const out = removeQueuedIdea([q({ id: "a" }), q({ id: "b" }), q({ id: "c" })], "b");
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("takeNextIdea", () => {
  it("takes from the FRONT and returns the rest", () => {
    const { next, rest } = takeNextIdea([q({ id: "a" }), q({ id: "b" })]);
    expect(next?.id).toBe("a");
    expect(rest.map((i) => i.id)).toEqual(["b"]);
  });

  it("is a safe no-op on an empty queue", () => {
    expect(takeNextIdea([])).toEqual({ next: null, rest: [] });
  });
});

describe("queueSendAction", () => {
  it("waits while a turn is still building", () => {
    expect(queueSendAction({ hasQueued: true, busy: true, paused: false })).toBe("wait");
  });

  it("sends the next idea the moment Ari goes idle after a clean finish", () => {
    expect(queueSendAction({ hasQueued: true, busy: false, paused: false })).toBe("send");
  });

  it("holds for a kid's confirmation after a stop or failure", () => {
    // Owner decision: a queued edit must never chain onto a game that just
    // broke or was stopped mid-build — the kid says go.
    expect(queueSendAction({ hasQueued: true, busy: false, paused: true })).toBe("hold");
  });

  it("still holds (never sends) while busy AND paused", () => {
    expect(queueSendAction({ hasQueued: true, busy: true, paused: true })).toBe("hold");
  });

  it("does nothing with an empty queue, paused or not", () => {
    expect(queueSendAction({ hasQueued: false, busy: false, paused: true })).toBe("wait");
    expect(queueSendAction({ hasQueued: false, busy: false, paused: false })).toBe("wait");
  });
});

describe("sanitizeQueue", () => {
  it("keeps well-formed ideas from persisted chats", () => {
    const queue = [q({ id: "a" }), q({ id: "b" })];
    expect(sanitizeQueue(queue)).toEqual(queue);
  });

  it("drops junk instead of throwing (hand-edited or older localStorage)", () => {
    const out = sanitizeQueue([q({ id: "a" }), null, { id: "b" }, { text: "x", createdAt: 1 }, "nope"]);
    expect(out.map((i) => i.id)).toEqual(["a"]);
  });

  it("returns [] for anything that isn't an array", () => {
    expect(sanitizeQueue(undefined)).toEqual([]);
    expect(sanitizeQueue("[]")).toEqual([]);
  });

  it("truncates a queue longer than the cap", () => {
    const many = Array.from({ length: MAX_QUEUED + 3 }, (_, n) => q({ id: `i${n}` }));
    expect(sanitizeQueue(many)).toHaveLength(MAX_QUEUED);
  });
});
