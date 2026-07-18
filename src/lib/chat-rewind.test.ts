import { describe, expect, it } from "vitest";
import { canContinueFromHere } from "./chat-rewind";
import type { ChatMessage } from "@/types/chat.types";

function msg(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "assistant", text: "", createdAt: 0, ...extra };
}

describe("canContinueFromHere", () => {
  const messages = [msg("a"), msg("b", { artifactHtml: "<html>v1</html>" }), msg("c"), msg("d", { artifactHtml: "<html>v2</html>" })];

  it("offers it on an earlier game message with something after it", () => {
    expect(canContinueFromHere(messages, 1, undefined)).toBe(true);
  });

  it("does not offer it on a message with no game", () => {
    expect(canContinueFromHere(messages, 0, undefined)).toBe(false);
    expect(canContinueFromHere(messages, 2, undefined)).toBe(false);
  });

  it("does not offer it on the last message — nothing to diverge from", () => {
    expect(canContinueFromHere(messages, 3, undefined)).toBe(false);
  });

  it("does not offer it on the message that is already pinned — no-op", () => {
    expect(canContinueFromHere(messages, 1, "b")).toBe(false);
  });

  it("still offers it on a DIFFERENT game message while another is pinned", () => {
    const three = [...messages, msg("e", { artifactHtml: "<html>v3</html>" })];
    expect(canContinueFromHere(three, 1, "d")).toBe(true);
  });

  it("returns false for an out-of-range index", () => {
    expect(canContinueFromHere(messages, 99, undefined)).toBe(false);
  });
});
