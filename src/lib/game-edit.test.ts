// Tests for the patch-based feature-edit path (BUG-FIX-LOG class fix,
// 2026-07-18: an LLM asked to "add one feature" to an already-good game was
// regenerating the whole file and regressing unrelated parts). Written
// FIRST, against code that doesn't exist yet.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isGameEditTurn, currentGameHtml, editReplyProse, GAME_EDIT_PROMPT_SECTION } from "./game-edit";
import type { ChatMessage } from "@/types/chat.types";

import { extractArtifact } from "./gemini";

let seq = 0;
// Real assistant messages always carry BOTH `text` (raw reply, fence and
// all) and `artifactHtml` (already extracted) together — route.ts's `send({
// type: "done", text, artifactHtml })` sets both from the same generation.
// isGameBuildTurn checks the field; findLastGameIndex/currentGameHtml
// re-derive from text — keep both populated so tests match real data.
function msg(role: "child" | "assistant", text: string): ChatMessage {
  seq += 1;
  const artifactHtml = role === "assistant" ? extractArtifact(text).artifactHtml : undefined;
  return { id: `m${seq}`, role, text, artifactHtml, createdAt: seq };
}

const GAME_V1 = "Here you go!\n```html\n<!doctype html><html><body>GAME V1 CODE</body></html>\n```";
const GAME_V2 = "Made it faster!\n```html\n<!doctype html><html><body>GAME V2 CODE</body></html>\n```";

describe("isGameEditTurn — a build-shaped turn that already has a game to edit", () => {
  it("is false on a fresh build (no game exists yet)", () => {
    expect(isGameEditTurn("make me a racing game", [])).toBe(false);
  });

  it("is true once a game already exists and the child asks to change it", () => {
    const history = [msg("child", "make me a racing game"), msg("assistant", GAME_V1)];
    expect(isGameEditTurn("make the car faster", history)).toBe(true);
  });

  // Matches isGameBuildTurn's own documented tradeoff (builder-mode.ts):
  // once a game exists, ANY message is treated as build-shaped, because
  // there's no reliable keyword rule that tells "make the player jump
  // higher" apart from "what do pandas eat" — the artifact in history is
  // the signal, deliberately over-inclusive. Robustness against a truly
  // off-topic message routed here isn't isGameEditTurn's job: the edit
  // prompt itself is hedged ("if this message isn't about the game, just
  // answer normally"), and the route treats a plain-prose reply
  // (applyPatch's no_patch_in_reply) as ordinary chat rather than forcing a
  // wasted regeneration — see api/chat/route.test.ts.
  it("is (over-inclusively, like isGameBuildTurn) true for any message once a game exists", () => {
    const history = [msg("child", "make me a racing game"), msg("assistant", GAME_V1)];
    expect(isGameEditTurn("what do pandas eat?", history)).toBe(true);
  });
});

describe("currentGameHtml — locates the newest game's source", () => {
  it("returns undefined when no game exists", () => {
    expect(currentGameHtml([msg("child", "hi"), msg("assistant", "hello!")])).toBeUndefined();
  });

  it("returns the newest game's HTML when several versions exist", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V1), msg("child", "faster"), msg("assistant", GAME_V2)];
    expect(currentGameHtml(history)).toContain("GAME V2 CODE");
    expect(currentGameHtml(history)).not.toContain("GAME V1 CODE");
  });
});

describe("editReplyProse — splits the kid-facing line from the SEARCH/REPLACE hunks", () => {
  it("returns the sentence written before the first SEARCH marker", () => {
    const reply = `Added a medic kit for the enemy! 🎮\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE`;
    expect(editReplyProse(reply)).toBe("Added a medic kit for the enemy! 🎮");
  });

  it("falls back to a friendly default when the model left no prose", () => {
    const reply = `<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE`;
    expect(editReplyProse(reply)).toMatch(/\S/); // never blank
  });

  it("returns the whole trimmed text when no patch marker is present at all", () => {
    expect(editReplyProse("just a friendly reply, no patch")).toBe("just a friendly reply, no patch");
  });
});

describe("GAME_EDIT_PROMPT_SECTION — the patch contract for feature-edit turns", () => {
  it("instructs the SEARCH/REPLACE format applyPatch() parses", () => {
    expect(GAME_EDIT_PROMPT_SECTION).toContain("<<<<<<< SEARCH");
    expect(GAME_EDIT_PROMPT_SECTION).toContain("=======");
    expect(GAME_EDIT_PROMPT_SECTION).toContain(">>>>>>> REPLACE");
  });

  it("instructs a short kid-facing line before the patch, not a full file", () => {
    expect(GAME_EDIT_PROMPT_SECTION).toMatch(/one short|short.*sentence/i);
    expect(GAME_EDIT_PROMPT_SECTION).toMatch(/not.*full|no full|never.*full/i);
  });

  it("instructs everything unmentioned to stay byte-for-byte identical", () => {
    expect(GAME_EDIT_PROMPT_SECTION).toMatch(/byte-for-byte|exactly|character for character/i);
    expect(GAME_EDIT_PROMPT_SECTION).toMatch(/only what|change only/i);
  });

  // isGameEditTurn is deliberately over-inclusive (see above) — this hedge is
  // what keeps an off-topic message ("what do pandas eat?") routed here from
  // being forced into patch format; the model should just answer normally.
  it("hedges: if the message isn't actually about the game, just answer normally instead of forcing a patch", () => {
    expect(GAME_EDIT_PROMPT_SECTION).toMatch(/if (this|the) (message|request) (is|isn't|is not)/i);
    expect(GAME_EDIT_PROMPT_SECTION).toMatch(/answer normally|just (reply|answer)/i);
  });
});
