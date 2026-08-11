// Zero test coverage existed on this file before 2026-08-11 — found while
// investigating an owner report ("chat history from this morning is
// missing, published game not in chat history"). Root cause: sanitizeConversation
// rejects (400, fail-closed) any conversation whose JSON exceeds MAX_CONVO_BYTES,
// and the write-through path (ChatPanel.container.tsx) PUTs the WHOLE
// conversation — every message's own artifactHtml included — on every
// finished turn. A long game-editing session (each edit's assistant message
// keeps its own full HTML snapshot, by owner decision, so "the previous
// version is available in the chat window") grows past the cap, and once it
// does, EVERY subsequent turn's write-through save silently fails — nothing
// after that point ever reaches the server, with no user-visible error
// (console-only warning). The child's own device/localStorage is unaffected
// (see chat-store.ts) — this is a SERVER-persistence-only gap, not data loss
// on the device that produced it.
import { describe, it, expect } from "vitest";
import { sanitizeConversation, splitOldArtifacts, MAX_CONVO_BYTES, MAX_TITLE, INLINE_ARTIFACT_BUDGET_BYTES } from "./chat-history";
import type { Conversation, ChatMessage } from "@/types/chat.types";

function childMsg(id: string, text = "make it better"): ChatMessage {
  return { id, role: "child", text, createdAt: Date.now() };
}
function gameMsg(id: string, artifactKB: number): ChatMessage {
  return {
    id,
    role: "assistant",
    text: "Here's your updated game!",
    createdAt: Date.now(),
    artifactHtml: "x".repeat(artifactKB * 1024),
  };
}
function convo(messages: ChatMessage[], overrides: Partial<Conversation> = {}): Conversation {
  return { id: "c1", title: "My Game", messages, ...overrides };
}

describe("sanitizeConversation — the fail-closed whitelist boundary", () => {
  it("rejects a non-object / null input", () => {
    expect(sanitizeConversation(null)).toBeNull();
    expect(sanitizeConversation("nope")).toBeNull();
  });

  it("rejects a missing/oversized id or title", () => {
    expect(sanitizeConversation(convo([childMsg("m1")], { id: "" }))).toBeNull();
    expect(sanitizeConversation(convo([childMsg("m1")], { id: "x".repeat(101) }))).toBeNull();
    expect(sanitizeConversation(convo([childMsg("m1")], { title: "x".repeat(MAX_TITLE + 1) }))).toBeNull();
  });

  it("rejects zero messages", () => {
    expect(sanitizeConversation(convo([]))).toBeNull();
  });

  it("rejects a message missing required fields", () => {
    expect(sanitizeConversation(convo([{ id: "m1", role: "child" } as unknown as ChatMessage]))).toBeNull();
  });

  it("accepts a normal small conversation, preserving artifactHtml", () => {
    const c = convo([childMsg("m1"), gameMsg("m2", 50)]);
    const out = sanitizeConversation(c);
    expect(out).not.toBeNull();
    expect(out!.messages[1]!.artifactHtml).toContain("x");
  });

  // ── The 2026-08-11 incident ──────────────────────────────────────────────
  it("a realistic long game-editing session (30 edits, ~200KB artifacts each) must NOT be silently rejected", () => {
    // Exactly the shape of an owner-reported morning session: a 3D game
    // edited turn after turn, each turn's reply keeping its own full HTML
    // snapshot (owner decision: rollback is "the previous version available
    // in the chat window"). 30 turns x ~200KB is a realistic, NOT
    // pathological, session — this must fit under MAX_CONVO_BYTES.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(childMsg(`c${i}`, `edit request number ${i}`));
      messages.push(gameMsg(`a${i}`, 200));
    }
    const c = convo(messages);
    expect(JSON.stringify(c).length).toBeGreaterThan(2_000_000); // over the OLD cap
    const out = sanitizeConversation(c);
    expect(out).not.toBeNull(); // must survive under the current cap
    expect(out!.messages.length).toBe(60);
  });

  it("still fails closed on a truly pathological payload (well beyond any realistic session)", () => {
    const huge = convo([childMsg("c1"), gameMsg("a1", (MAX_CONVO_BYTES / 1024) * 2)]);
    expect(sanitizeConversation(huge)).toBeNull();
  });

  it("preserves workspace/editSlug/pinnedAt when valid, drops them when not", () => {
    const c = convo([childMsg("m1")], {
      workspace: "bible-teacher",
      editSlug: "my-cool-game-1",
      pinnedAt: 123,
    } as Partial<Conversation>);
    const out = sanitizeConversation(c);
    expect(out!.workspace).toBe("bible-teacher");
    expect(out!.editSlug).toBe("my-cool-game-1");
    expect(out!.pinnedAt).toBe(123);

    const bad = convo([childMsg("m1")], { editSlug: "NOT VALID!!" } as Partial<Conversation>);
    expect(sanitizeConversation(bad)!.editSlug).toBeUndefined();
  });
});

// ── The scalable follow-up (2026-08-11, owner decision): only the recent
// ~2MB of artifacts stay inlined; older ones move to their own storage row
// and are fetched on demand. splitOldArtifacts is the pure DECISION function
// db.ts's SqliteChatHistoryStore.upsert calls before writing.
describe("splitOldArtifacts — keep the recent window inline, externalize the rest", () => {
  it("a small conversation is untouched — everything stays inline, nothing to store", () => {
    const messages = [childMsg("c1"), gameMsg("a1", 50), childMsg("c2"), gameMsg("a2", 50)];
    const { messages: out, toStore } = splitOldArtifacts(messages);
    expect(toStore).toEqual([]);
    expect(out).toEqual(messages);
  });

  it("a long session keeps the NEWEST artifacts inline and externalizes the oldest", () => {
    // 30 edits x 200KB = 6MB total, 3x the 2MB budget — this is EXACTLY the
    // realistic-session shape from the sanitizeConversation test above,
    // which now must never be rejected: it gets trimmed instead.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(childMsg(`c${i}`, `edit ${i}`));
      messages.push(gameMsg(`a${i}`, 200));
    }
    const { messages: out, toStore } = splitOldArtifacts(messages);
    // The result must now fit comfortably under the OLD hard cap that used
    // to reject this exact session shape.
    expect(JSON.stringify(out).length).toBeLessThan(MAX_CONVO_BYTES);
    expect(out.length).toBe(messages.length); // no message dropped, only trimmed
    // The newest artifact-carrying message stays inline...
    expect(out[out.length - 1]!.artifactHtml).toBeDefined();
    expect(out[out.length - 1]!.artifactExternal).toBeUndefined();
    // ...the oldest one is externalized, not silently deleted.
    expect(out[1]!.artifactHtml).toBeUndefined();
    expect(out[1]!.artifactExternal).toBe(true);
    expect(toStore.length).toBeGreaterThan(0);
    expect(toStore.find((a) => a.messageId === "a0")).toBeDefined();
  });

  it("externalized artifacts are recoverable — toStore carries the real html, nothing is lost", () => {
    const messages = Array.from({ length: 20 }, (_, i) => gameMsg(`a${i}`, 200)); // 4MB, 2x budget
    const { toStore } = splitOldArtifacts(messages);
    const first = toStore.find((a) => a.messageId === "a0")!;
    expect(first.html.length).toBe(200 * 1024);
  });

  it("respects a custom budget (unit-testable independent of the real 2MB constant)", () => {
    const messages = [gameMsg("a1", 10), gameMsg("a2", 10), gameMsg("a3", 10)];
    const { messages: out, toStore } = splitOldArtifacts(messages, 15 * 1024); // fits ~1.5 messages
    expect(toStore.length).toBe(1); // only the oldest is pushed out
    expect(out[0]!.artifactExternal).toBe(true);
    expect(out[1]!.artifactHtml).toBeDefined();
    expect(out[2]!.artifactHtml).toBeDefined();
  });

  it("messages without any artifact pass through untouched regardless of budget", () => {
    const messages = [childMsg("c1"), childMsg("c2"), childMsg("c3")];
    const { messages: out, toStore } = splitOldArtifacts(messages, 0);
    expect(toStore).toEqual([]);
    expect(out).toEqual(messages);
  });

  it("uses INLINE_ARTIFACT_BUDGET_BYTES as the real default", () => {
    const messages = [gameMsg("a1", (INLINE_ARTIFACT_BUDGET_BYTES / 1024) * 2)]; // 2x budget, alone
    const { toStore } = splitOldArtifacts(messages);
    // A single message bigger than the whole budget still stays inline —
    // never externalize the ONE most-recent artifact-carrying message, or a
    // kid's current game would need an extra fetch just to keep playing it.
    expect(toStore).toEqual([]);
  });
});
