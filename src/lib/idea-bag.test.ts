// Idea Bag (docs/PRD-IDEA-BUTTON.md): spoken thoughts captured during play,
// stored device-local (text only — audio never exists), bundled into ONE chat
// message on "✨ Make my game better!". The bag empties only on a successful
// generation — a failed send must never eat a kid's ideas.
import { describe, expect, it } from "vitest";
import {
  addIdea,
  baggedFor,
  composeIdeaBundle,
  discardIdea,
  IDEA_BUNDLE_LABEL,
  loadIdeas,
  markSent,
  MAX_BAGGED_PER_CONVO,
  MAX_TOTAL_RECORDS,
  saveIdeas,
} from "./idea-bag";
import type { IdeaRecord } from "@/types/idea-bag.types";

function idea(over: Partial<IdeaRecord> = {}): IdeaRecord {
  return {
    id: over.id ?? crypto.randomUUID(),
    gameConvoId: "convo-1",
    text: "make the dino purple",
    createdAt: 1,
    source: "voice",
    status: "bagged",
    ...over,
  };
}

/** Minimal in-memory Storage. */
function fakeStorage(init: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(init));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("addIdea", () => {
  it("appends a trimmed bagged voice idea for the convo", () => {
    const out = addIdea([], "c1", "  the dino gets stuck  ", { id: "i1", now: 42 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "i1",
      gameConvoId: "c1",
      text: "the dino gets stuck",
      createdAt: 42,
      source: "voice",
      status: "bagged",
    });
  });

  it("ignores empty and whitespace-only speech (a stray tap adds nothing)", () => {
    expect(addIdea([], "c1", "")).toHaveLength(0);
    expect(addIdea([], "c1", "   \n ")).toHaveLength(0);
  });

  it("caps bagged ideas per convo by dropping the OLDEST bagged one", () => {
    let ideas: IdeaRecord[] = [];
    for (let i = 0; i < MAX_BAGGED_PER_CONVO; i++) {
      ideas = addIdea(ideas, "c1", `idea ${i}`, { id: `i${i}`, now: i });
    }
    ideas = addIdea(ideas, "c1", "one too many", { id: "overflow", now: 999 });
    const bagged = baggedFor(ideas, "c1");
    expect(bagged).toHaveLength(MAX_BAGGED_PER_CONVO);
    expect(bagged.some((i) => i.id === "i0")).toBe(false); // oldest gone
    expect(bagged.some((i) => i.id === "overflow")).toBe(true); // newest kept
  });

  it("the cap is per convo — a full bag elsewhere doesn't block this game", () => {
    let ideas: IdeaRecord[] = [];
    for (let i = 0; i < MAX_BAGGED_PER_CONVO; i++) {
      ideas = addIdea(ideas, "other", `idea ${i}`, { id: `o${i}`, now: i });
    }
    ideas = addIdea(ideas, "c1", "fresh game idea", { id: "fresh", now: 999 });
    expect(baggedFor(ideas, "c1")).toHaveLength(1);
    expect(baggedFor(ideas, "other")).toHaveLength(MAX_BAGGED_PER_CONVO);
  });

  it("prunes total records to MAX_TOTAL_RECORDS dropping oldest NON-bagged first", () => {
    let ideas: IdeaRecord[] = [];
    for (let i = 0; i < MAX_TOTAL_RECORDS; i++) {
      ideas = [...ideas, idea({ id: `s${i}`, gameConvoId: `c${i}`, status: "sent", createdAt: i })];
    }
    ideas = addIdea(ideas, "c1", "new thought", { id: "new", now: 9999 });
    expect(ideas.length).toBeLessThanOrEqual(MAX_TOTAL_RECORDS);
    expect(ideas.some((i) => i.id === "new")).toBe(true); // bagged survives the prune
    expect(ideas.some((i) => i.id === "s0")).toBe(false); // oldest sent dropped
  });
});

describe("baggedFor", () => {
  it("returns only bagged ideas of that convo, oldest first", () => {
    const ideas = [
      idea({ id: "a", gameConvoId: "c1", createdAt: 3 }),
      idea({ id: "b", gameConvoId: "c2", createdAt: 1 }),
      idea({ id: "c", gameConvoId: "c1", createdAt: 1 }),
      idea({ id: "d", gameConvoId: "c1", createdAt: 2, status: "sent" }),
      idea({ id: "e", gameConvoId: "c1", createdAt: 2, status: "discarded" }),
    ];
    expect(baggedFor(ideas, "c1").map((i) => i.id)).toEqual(["c", "a"]);
  });
});

describe("discardIdea", () => {
  it("flips the idea to discarded (record kept — it feeds the discard-rate signal)", () => {
    const out = discardIdea([idea({ id: "a" })], "a");
    expect(out[0]!.status).toBe("discarded");
  });
  it("unknown id is a no-op", () => {
    const ideas = [idea({ id: "a" })];
    expect(discardIdea(ideas, "nope")).toEqual(ideas);
  });
});

describe("markSent", () => {
  it("flips ALL bagged ideas of the convo to sent, pointing at the chat message", () => {
    const ideas = [
      idea({ id: "a", gameConvoId: "c1" }),
      idea({ id: "b", gameConvoId: "c1" }),
      idea({ id: "c", gameConvoId: "c2" }), // other game — untouched
      idea({ id: "d", gameConvoId: "c1", status: "discarded" }), // not bagged — untouched
    ];
    const out = markSent(ideas, "c1", "msg-9");
    expect(out.find((i) => i.id === "a")).toMatchObject({ status: "sent", sentInMessageId: "msg-9" });
    expect(out.find((i) => i.id === "b")).toMatchObject({ status: "sent", sentInMessageId: "msg-9" });
    expect(out.find((i) => i.id === "c")!.status).toBe("bagged");
    expect(out.find((i) => i.id === "d")!.status).toBe("discarded");
  });
});

describe("composeIdeaBundle", () => {
  it("bullets every idea under the kid-voiced label", () => {
    const text = composeIdeaBundle(["fix the sticky ground", "make the dino purple"]);
    expect(text).toBe(`${IDEA_BUNDLE_LABEL}\n- fix the sticky ground\n- make the dino purple`);
  });
  it("a single idea is still a bullet (the 🎒 label needs the list shape)", () => {
    expect(composeIdeaBundle(["add a rainbow"])).toBe(`${IDEA_BUNDLE_LABEL}\n- add a rainbow`);
  });
  it("empty list composes to empty string (caller must not send it)", () => {
    expect(composeIdeaBundle([])).toBe("");
  });
});

describe("persistence — same never-throw contract as chat-store", () => {
  it("save/load round-trips", () => {
    const storage = fakeStorage();
    const ideas = [idea({ id: "a" }), idea({ id: "b", status: "sent", sentInMessageId: "m1" })];
    saveIdeas(storage, ideas);
    expect(loadIdeas(storage)).toEqual(ideas);
  });

  it("load returns [] for absent, garbage, or wrong-shaped data", () => {
    expect(loadIdeas(fakeStorage())).toEqual([]);
    expect(loadIdeas(fakeStorage({ "kidgemini:ideas:v1": "not json {{" }))).toEqual([]);
    expect(loadIdeas(fakeStorage({ "kidgemini:ideas:v1": '{"nope":1}' }))).toEqual([]);
    // records missing required fields are dropped, valid ones kept
    const mixed = JSON.stringify([idea({ id: "ok" }), { id: "broken" }]);
    expect(loadIdeas(fakeStorage({ "kidgemini:ideas:v1": mixed })).map((i) => i.id)).toEqual(["ok"]);
  });

  it("save never throws (quota / private mode)", () => {
    const storage = fakeStorage();
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => saveIdeas(storage, [idea()])).not.toThrow();
  });
});
