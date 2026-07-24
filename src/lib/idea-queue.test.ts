// Idea Queue v2 (docs/PRD-IDEA-QUEUE-V2.md): ONE line for every idea — typed
// (`build`, one row = one turn) or spoken over the preview (`tweak`,
// consecutive rows bundle into one turn). Drains on clean finishes only,
// HOLDS with a reason after a stop/failure ("failed") or a restore
// ("restored"), and settles briefly before sending idle tweaks so a kid
// speaking three thoughts gets one bundle, not the first thought built alone.
import { describe, expect, it } from "vitest";
import {
  IDEA_BUNDLE_LABEL,
  MAX_QUEUED,
  TWEAK_SETTLE_MS,
  canQueue,
  composeIdeaBundle,
  drainDecision,
  enqueueIdea,
  enqueueTweak,
  holdAfterKidAction,
  removeQueuedIdea,
  sanitizeQueue,
  takeNextSend,
  updateQueuedIdea,
} from "./idea-queue";
import type { QueuedIdea } from "@/types/idea-queue.types";

function q(over: Partial<QueuedIdea> = {}): QueuedIdea {
  return { id: "i1", text: "add a dragon boss", kind: "build", createdAt: 1, ...over };
}
function tweak(over: Partial<QueuedIdea> = {}): QueuedIdea {
  return q({ id: "t1", text: "make the sky blue", kind: "tweak", ...over });
}

describe("enqueueIdea", () => {
  it("appends a trimmed idea to the back of the line (FIFO), kind build by default", () => {
    const out = enqueueIdea([q({ id: "a", text: "first" })], "  second  ", { id: "b", now: 42 });
    expect(out.map((i) => i.text)).toEqual(["first", "second"]);
    expect(out[1]).toMatchObject({ id: "b", text: "second", kind: "build", createdAt: 42 });
  });

  it("carries an explicit kind", () => {
    const out = enqueueIdea([], "louder music", { kind: "tweak" });
    expect(out[0]!.kind).toBe("tweak");
  });

  it("ignores an empty or whitespace-only idea", () => {
    const queue = [q()];
    expect(enqueueIdea(queue, "   ")).toBe(queue);
    expect(enqueueIdea([], "")).toEqual([]);
  });

  it("never grows past the cap — the oldest idea is NOT dropped", () => {
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

describe("enqueueTweak (mic path — a spoken idea has no composer holding it)", () => {
  it("queues a tweak row while there is room", () => {
    const { queue, outcome } = enqueueTweak([q({ id: "a" })], "louder jump sound", { id: "t" });
    expect(outcome).toBe("queued");
    expect(queue[1]).toMatchObject({ id: "t", kind: "tweak", text: "louder jump sound" });
  });

  it("at the cap, MERGES into a trailing tweak row instead of refusing into the void", () => {
    const full = [
      ...Array.from({ length: MAX_QUEUED - 1 }, (_, n) => q({ id: `b${n}` })),
      tweak({ id: "t-last", text: "make the sky blue" }),
    ];
    const { queue, outcome } = enqueueTweak(full, "add stars too");
    expect(outcome).toBe("merged");
    expect(queue).toHaveLength(MAX_QUEUED);
    expect(queue.at(-1)!.text).toBe("make the sky blue; add stars too");
  });

  it("at the cap with a BUILD row last, refuses (the mic bar says why and keeps the transcript)", () => {
    const full = Array.from({ length: MAX_QUEUED }, (_, n) => q({ id: `b${n}` }));
    const { queue, outcome } = enqueueTweak(full, "one more");
    expect(outcome).toBe("refused");
    expect(queue).toBe(full);
  });

  it("ignores an empty transcript", () => {
    const queue = [q()];
    expect(enqueueTweak(queue, "   ").outcome).toBe("refused");
    expect(enqueueTweak(queue, "   ").queue).toBe(queue);
  });
});

describe("updateQueuedIdea", () => {
  it("✏️ rewrites the waiting idea in place, trimmed, keeping its kind and place", () => {
    const out = updateQueuedIdea([q({ id: "a" }), tweak({ id: "b" })], "b", "  make the sky purple ");
    expect(out[1]).toMatchObject({ id: "b", kind: "tweak", text: "make the sky purple" });
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("treats an emptied edit as a no-op, not a silent delete", () => {
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

describe("takeNextSend (the drain unit — PRD v2 §3.2)", () => {
  it("front BUILD row: takes exactly that one row, message verbatim", () => {
    const { message, taken, rest, isTweakBundle } = takeNextSend([
      q({ id: "a", text: "a racing game" }),
      tweak({ id: "t" }),
    ]);
    expect(message).toBe("a racing game");
    expect(isTweakBundle).toBe(false);
    expect(taken.map((i) => i.id)).toEqual(["a"]);
    expect(rest.map((i) => i.id)).toEqual(["t"]);
  });

  it("front TWEAK row: takes the maximal consecutive run and bundles it into ONE message", () => {
    const { message, taken, rest, isTweakBundle } = takeNextSend([
      tweak({ id: "t1", text: "make the sky blue" }),
      tweak({ id: "t2", text: "add jump sound" }),
      q({ id: "b", text: "a racing game" }),
      tweak({ id: "t3", text: "bigger stars" }),
    ]);
    expect(isTweakBundle).toBe(true);
    expect(taken.map((i) => i.id)).toEqual(["t1", "t2"]);
    expect(message).toBe(`${IDEA_BUNDLE_LABEL}\n- make the sky blue\n- add jump sound`);
    // The build and the LATER tweak stay exactly where they were.
    expect(rest.map((i) => i.id)).toEqual(["b", "t3"]);
  });

  it("a lone tweak still ships as a bundle message (consistent bubble label)", () => {
    const { message, isTweakBundle } = takeNextSend([tweak({ text: "make the sky blue" })]);
    expect(isTweakBundle).toBe(true);
    expect(message).toBe(`${IDEA_BUNDLE_LABEL}\n- make the sky blue`);
  });

  it("is a safe no-op on an empty queue", () => {
    expect(takeNextSend([])).toEqual({ message: "", taken: [], rest: [], isTweakBundle: false });
  });
});

describe("composeIdeaBundle", () => {
  it("bullets every text under the kid-voiced label", () => {
    expect(composeIdeaBundle(["a", "b"])).toBe(`${IDEA_BUNDLE_LABEL}\n- a\n- b`);
  });
  it("returns empty for an empty list (never send a bare label)", () => {
    expect(composeIdeaBundle([])).toBe("");
  });
});

describe("drainDecision (PRD v2 §3.3 — the one place send/hold/wait/settle is decided)", () => {
  const base = { busy: false, hold: null, now: 100_000, lastEnqueueAt: 0 } as const;

  it("waits with an empty line, whatever else is true", () => {
    expect(drainDecision({ ...base, queue: [], busy: true }).action).toBe("wait");
    expect(drainDecision({ ...base, queue: [], hold: "failed" }).action).toBe("wait");
  });

  it("holds whenever a hold reason is set — busy or not", () => {
    expect(drainDecision({ ...base, queue: [q()], hold: "failed" }).action).toBe("hold");
    expect(drainDecision({ ...base, queue: [q()], hold: "restored", busy: true }).action).toBe("hold");
  });

  it("waits while a turn is still building", () => {
    expect(drainDecision({ ...base, queue: [q()], busy: true }).action).toBe("wait");
  });

  it("sends a front BUILD row immediately when idle", () => {
    expect(drainDecision({ ...base, queue: [q()], lastEnqueueAt: base.now }).action).toBe("send");
  });

  it("SETTLES a fresh front tweak when idle — a kid mid-thought gets one bundle, not a premature solo build", () => {
    const d = drainDecision({ ...base, queue: [tweak()], lastEnqueueAt: base.now - 1_000 });
    expect(d.action).toBe("settle");
    expect(d.waitMs).toBe(TWEAK_SETTLE_MS - 1_000);
  });

  it("sends the tweak bundle once the settle window has passed", () => {
    const d = drainDecision({ ...base, queue: [tweak()], lastEnqueueAt: base.now - TWEAK_SETTLE_MS });
    expect(d.action).toBe("send");
  });

  it("lastEnqueueAt 0 (unknown / Send-now) sends without settling", () => {
    expect(drainDecision({ ...base, queue: [tweak()] }).action).toBe("send");
  });
});

describe("holdAfterKidAction (PRD v2 §3.5 — the silent-resume fix)", () => {
  it("a deliberate kid action clears a 'restored' hold (nothing was broken)", () => {
    expect(holdAfterKidAction("restored")).toBeNull();
  });
  it("but NEVER clears a 'failed' hold — only the explicit yes does", () => {
    expect(holdAfterKidAction("failed")).toBe("failed");
  });
  it("no hold stays no hold", () => {
    expect(holdAfterKidAction(null)).toBeNull();
  });
});

describe("sanitizeQueue", () => {
  it("keeps well-formed v2 ideas from persisted chats", () => {
    const queue = [q({ id: "a" }), tweak({ id: "b" })];
    expect(sanitizeQueue(queue)).toEqual(queue);
  });

  it("back-compat: a v1 row without a kind becomes a 'build'", () => {
    const out = sanitizeQueue([{ id: "a", text: "x", createdAt: 1 }]);
    expect(out).toEqual([{ id: "a", text: "x", createdAt: 1, kind: "build" }]);
  });

  it("drops a row with an unknown kind (a queued row auto-sends — storage is never trusted)", () => {
    const out = sanitizeQueue([q({ id: "a" }), { id: "b", text: "x", createdAt: 1, kind: "evil" }]);
    expect(out.map((i) => i.id)).toEqual(["a"]);
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

describe("canQueue", () => {
  it("is true below the cap and false at it", () => {
    expect(canQueue([])).toBe(true);
    expect(canQueue(Array.from({ length: MAX_QUEUED - 1 }, () => q()))).toBe(true);
    expect(canQueue(Array.from({ length: MAX_QUEUED }, () => q()))).toBe(false);
  });
});
