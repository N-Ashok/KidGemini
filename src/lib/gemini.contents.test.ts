// Pins the request shape sent to Gemini: history as alternating turns, and —
// since picture uploads (2026-07-09) — the image travelling as an inlineData
// part ON THE FINAL USER TURN ONLY (never in history: images aren't persisted).

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildChatContents } from "./gemini";
import type { ChatMessage } from "@/types/chat.types";

const history: ChatMessage[] = [
  { id: "1", role: "child", text: "hi", createdAt: 1 },
  { id: "2", role: "assistant", text: "hello!", createdAt: 2 },
];

describe("buildChatContents", () => {
  it("maps history roles and appends the new message as the last user turn", () => {
    const c = buildChatContents({ history, message: "make a game" });
    expect(c.map((t) => t.role)).toEqual(["user", "model", "user"]);
    expect(c[2]!.parts).toEqual([{ text: "make a game" }]);
  });

  // BUG-FIX-LOG 2026-07-27: provider HARASSMENT:LOW false positives on kids'
  // battle games clear when truthful "I am a game designer" context rides in
  // the USER turn (verified live — the system prompt saying the same thing did
  // NOT clear them). The context is a SEPARATE leading part of the final user
  // turn so the child's own words stay intact.
  it("prepends safetyContext as its own leading part of the final user turn only", () => {
    const c = buildChatContents({ history, message: "add mega evolution", safetyContext: "ctx" });
    expect(c[2]!.parts).toEqual([{ text: "ctx" }, { text: "add mega evolution" }]);
    // history turns must never carry the injected context
    expect(JSON.stringify(c.slice(0, -1))).not.toContain("ctx");
  });

  it("keeps safetyContext first even when a picture rides on the final turn", () => {
    const image = { mimeType: "image/jpeg" as const, data: "aGVsbG8=" };
    const c = buildChatContents({ history, message: "use this", image, safetyContext: "ctx" });
    expect(c[c.length - 1]!.parts).toEqual([
      { text: "ctx" },
      { inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
      { text: "use this" },
    ]);
  });

  it("attaches an uploaded picture as inlineData next to the final message text", () => {
    const image = { mimeType: "image/jpeg" as const, data: "aGVsbG8=" };
    const c = buildChatContents({ history, message: "what is in this picture?", image });
    const last = c[c.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.parts).toEqual([
      { inlineData: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
      { text: "what is in this picture?" },
    ]);
    // history turns must never carry image parts
    for (const turn of c.slice(0, -1)) {
      expect(JSON.stringify(turn)).not.toContain("inlineData");
    }
  });
});
