// One-time Idea Bag → Idea Queue migration (docs/PRD-IDEA-QUEUE-V2.md §5).
// The bag's localStorage records become `tweak` rows on their conversation's
// queue; the old key is cleared so the migration can never double-run.
import { describe, expect, it } from "vitest";
import { foldTweaksIntoQueue, takeBagForMigration } from "./idea-migrate";
import { MAX_QUEUED } from "./idea-queue";
import type { QueuedIdea } from "@/types/idea-queue.types";

const BAG_KEY = "kidgemini:ideas:v1";

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function bagRecord(over: Record<string, unknown> = {}) {
  return { id: "r1", gameConvoId: "c1", text: "make it faster", createdAt: 1, source: "voice", status: "bagged", ...over };
}

function build(id: string): QueuedIdea {
  return { id, text: `build ${id}`, kind: "build", createdAt: 1 };
}

describe("takeBagForMigration", () => {
  it("returns bagged texts grouped by conversation, oldest first", () => {
    const storage = fakeStorage({
      [BAG_KEY]: JSON.stringify([
        bagRecord({ id: "b", gameConvoId: "c1", text: "second", createdAt: 2 }),
        bagRecord({ id: "a", gameConvoId: "c1", text: "first", createdAt: 1 }),
        bagRecord({ id: "c", gameConvoId: "c2", text: "other game", createdAt: 3 }),
      ]),
    });
    expect(takeBagForMigration(storage)).toEqual({ c1: ["first", "second"], c2: ["other game"] });
  });

  it("ignores sent/discarded records (analytics history, not live intent)", () => {
    const storage = fakeStorage({
      [BAG_KEY]: JSON.stringify([
        bagRecord({ id: "a", status: "sent" }),
        bagRecord({ id: "b", status: "discarded" }),
        bagRecord({ id: "c", text: "still live" }),
      ]),
    });
    expect(takeBagForMigration(storage)).toEqual({ c1: ["still live"] });
  });

  it("REMOVES the key so a second run finds nothing (idempotence)", () => {
    const storage = fakeStorage({ [BAG_KEY]: JSON.stringify([bagRecord()]) });
    takeBagForMigration(storage);
    expect(takeBagForMigration(storage)).toBeNull();
    expect(storage.getItem(BAG_KEY)).toBeNull();
  });

  it("returns null when there is no bag, and never throws on junk", () => {
    expect(takeBagForMigration(fakeStorage())).toBeNull();
    expect(takeBagForMigration(fakeStorage({ [BAG_KEY]: "{not json" }))).toBeNull();
    expect(takeBagForMigration(fakeStorage({ [BAG_KEY]: JSON.stringify([null, "x", { id: 1 }]) }))).toBeNull();
  });
});

describe("foldTweaksIntoQueue", () => {
  it("adds one tweak row per text while slots remain", () => {
    const out = foldTweaksIntoQueue([build("b1")], ["sky blue", "more stars"], { now: 9 });
    expect(out.map((i) => i.kind)).toEqual(["build", "tweak", "tweak"]);
    expect(out.map((i) => i.text)).toEqual(["build b1", "sky blue", "more stars"]);
  });

  it("overflow merges into the FINAL tweak row — never dropped", () => {
    const texts = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
    const out = foldTweaksIntoQueue([], texts, { now: 9 });
    expect(out).toHaveLength(MAX_QUEUED);
    expect(out.at(-1)!.text).toBe("t5; t6; t7");
    expect(out.slice(0, -1).map((i) => i.text)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("a full all-build queue is the documented exception: texts are dropped (theoretical — both features shipped a day apart)", () => {
    const full = Array.from({ length: MAX_QUEUED }, (_, n) => build(`b${n}`));
    expect(foldTweaksIntoQueue(full, ["lost"], { now: 9 })).toEqual(full);
  });

  it("a full queue ending in a tweak merges everything into that row", () => {
    const full = [...Array.from({ length: MAX_QUEUED - 1 }, (_, n) => build(`b${n}`)), { id: "t", text: "sky", kind: "tweak", createdAt: 1 } as QueuedIdea];
    const out = foldTweaksIntoQueue(full, ["a", "b"], { now: 9 });
    expect(out).toHaveLength(MAX_QUEUED);
    expect(out.at(-1)!.text).toBe("sky; a; b");
  });

  it("no texts → the queue unchanged (and not a new array identity dance)", () => {
    const queue = [build("b1")];
    expect(foldTweaksIntoQueue(queue, [], { now: 9 })).toBe(queue);
  });
});
