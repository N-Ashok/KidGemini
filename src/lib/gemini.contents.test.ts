// Pins the request shape sent to Gemini: history as alternating turns, and —
// since picture uploads (2026-07-09) — the image travelling as an inlineData
// part ON THE FINAL USER TURN ONLY (never in history: images aren't persisted).

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildChatContents } from "./gemini";
import { gameSourceBlock, REPEATED_REQUEST_SECTION } from "./game-edit";
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

// 2026-08-25 PRD_EditTurnCost §4.A (PRD-PROMPT-CACHING Fix B/C): the current
// game's source and every per-turn directive ride the FINAL user turn, after
// the (now byte-stable) history, so the cacheable prefix is everything before
// them. Order inside the tail is the contract applyPatch and the safety
// framing both depend on — pinned here.
describe("buildChatContents — game source + per-turn directives ride the tail", () => {
  const html = "<!doctype html><html><body>GAME</body></html>";

  it("T.1 the game source is the FIRST part of the final user turn, fenced, exactly the bytes given", () => {
    const c = buildChatContents({ history, message: "make it faster", gameSource: html });
    const last = c[c.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.parts[0]).toEqual({ text: gameSourceBlock(html) });
    expect(gameSourceBlock(html)).toContain(html);
    expect(c.slice(0, -1).some((t) => t.parts.some((p) => "text" in p && p.text.includes("GAME")))).toBe(false); // never in history
  });

  it("T.2 tail order: game source → repeated-request directive → safety context → child's message → model names", () => {
    const c = buildChatContents({
      history, message: "make it faster", gameSource: html, tailSections: [REPEATED_REQUEST_SECTION], safetyContext: "ctx", modelNames: "names",
    });
    const texts = c[c.length - 1]!.parts.map((p) => ("text" in p ? p.text : "<image>"));
    expect(texts).toEqual([gameSourceBlock(html), REPEATED_REQUEST_SECTION, "ctx", "make it faster", "names"]);
  });

  it("T.3 with a picture, the image still sits right before the child's message (after the game block)", () => {
    const image = { mimeType: "image/png" as const, data: "AAAA" };
    const c = buildChatContents({ history, message: "use this", image, gameSource: html, safetyContext: "ctx" });
    const parts = c[c.length - 1]!.parts;
    expect(parts.map((p) => ("text" in p ? p.text : "<image>"))).toEqual([gameSourceBlock(html), "ctx", "<image>", "use this"]);
  });

  it("T.4 no game yet → no game block, tail is unchanged from before", () => {
    const c = buildChatContents({ history, message: "make a game" });
    expect(c[c.length - 1]!.parts).toEqual([{ text: "make a game" }]);
  });
});
