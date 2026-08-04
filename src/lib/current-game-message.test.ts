import { describe, it, expect } from "vitest";
import { currentGameMessage } from "./current-game-message";
import type { ChatMessage } from "@/types/chat.types";

const msg = (id: string, artifactHtml?: string): ChatMessage =>
  ({ id, role: "assistant", text: "", artifactHtml, createdAt: 0 }) as ChatMessage;

describe("currentGameMessage", () => {
  it("returns the LAST message carrying artifactHtml (the game currently on screen)", () => {
    const messages = [msg("1", "<html>v1</html>"), msg("2"), msg("3", "<html>v2</html>")];
    expect(currentGameMessage(messages)?.id).toBe("3");
  });

  it("returns undefined when no message has a game", () => {
    expect(currentGameMessage([msg("1"), msg("2")])).toBeUndefined();
  });

  it("returns undefined for an empty conversation", () => {
    expect(currentGameMessage([])).toBeUndefined();
  });
});
