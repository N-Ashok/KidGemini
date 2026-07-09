import { describe, it, expect } from "vitest";
import { searchChats } from "./chat-search";
import type { Conversation } from "@/types/chat.types";

/** BUG-FIX-LOG 2026-07-09: the sidebar's "Search chats" button shipped with no
 *  handler — it looked like Gemini's search but did nothing. */

const convo = (id: string, title: string, texts: string[], artifactHtml?: string): Conversation => ({
  id,
  title,
  messages: texts.map((text, i) => ({
    id: `${id}-m${i}`,
    role: i % 2 === 0 ? "child" : "assistant",
    text,
    createdAt: i,
    ...(artifactHtml && i === texts.length - 1 ? { artifactHtml } : {}),
  })),
});

const convos: Conversation[] = [
  convo("a", "Space shooter game", ["make me a space game", "Here is your game!"]),
  convo("b", "Story time", ["tell me about a friendly dragon", "Once upon a time…"]),
  convo("c", "Maths help", ["what is 7 times 8?", "7 × 8 = 56"], "<html><div>function draw()</div></html>"),
];

describe("chat-search — sidebar filter over titles and message text", () => {
  it("matches on conversation title", () => {
    expect(searchChats(convos, "shooter").map((c) => c.id)).toEqual(["a"]);
  });

  it("matches on message text, not just titles", () => {
    expect(searchChats(convos, "dragon").map((c) => c.id)).toEqual(["b"]);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(searchChats(convos, "  DRAGON ").map((c) => c.id)).toEqual(["b"]);
  });

  it("returns everything unchanged for an empty or whitespace query", () => {
    expect(searchChats(convos, "")).toEqual(convos);
    expect(searchChats(convos, "   ")).toEqual(convos);
  });

  it("returns [] when nothing matches", () => {
    expect(searchChats(convos, "unicorn rocket")).toEqual([]);
  });

  it("does NOT match inside game artifact HTML (noise like tag/function names)", () => {
    expect(searchChats(convos, "function draw")).toEqual([]);
  });

  it("preserves the incoming order of matches", () => {
    expect(searchChats(convos, "game").map((c) => c.id)).toEqual(["a"]);
    expect(searchChats(convos, "time").map((c) => c.id)).toEqual(["b", "c"]); // "Story time", "7 times 8"
  });
});
