// Tests for the patch-based feature-edit path (BUG-FIX-LOG class fix,
// 2026-07-18: an LLM asked to "add one feature" to an already-good game was
// regenerating the whole file and regressing unrelated parts). Written
// FIRST, against code that doesn't exist yet.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isGameEditTurn, currentGameHtml, editReplyProse, GAME_EDIT_PROMPT_SECTION,
  looksLikeAttemptedEdit, looksLikeCompleteDocument,
  patchEditsEnabled, isRepeatedRequest, regenReplyProse,
  REPEATED_REQUEST_SECTION, GAME_EDIT_STRICT_RETRY_SECTION, REBUILT_GAME_LINE,
  streamingDisplayText, EDIT_STREAM_WORKING_LINE,
} from "./game-edit";
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

  it("a pinned earlier message (Continue from here) wins over the newest", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V1), msg("child", "faster"), msg("assistant", GAME_V2)];
    expect(currentGameHtml(history, history[1]!.id)).toContain("GAME V1 CODE");
  });
});

describe("isGameEditTurn — with a pin active", () => {
  it("is still true against the pinned game even though it's not the newest", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V1), msg("child", "faster"), msg("assistant", GAME_V2)];
    expect(isGameEditTurn("add a jump", history, history[1]!.id)).toBe(true);
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

// Kill switch (BUG-FIX-LOG 2026-07-18, penguin-maze session): the user must
// be able to restore exact pre-patch behavior with one env flip — no git
// surgery. Gated INSIDE isGameEditTurn so the single choke point reverts
// both call sites (the route's edit branch and configFor's prompt section).
describe("patchEditsEnabled / GAME_EDIT_PATCH=off — instant pre-patch rollback", () => {
  const history = [msg("child", "make me a racing game"), msg("assistant", GAME_V1)];

  afterEach(() => {
    delete process.env.GAME_EDIT_PATCH;
  });

  it("defaults to enabled when the env var is unset", () => {
    expect(patchEditsEnabled({})).toBe(true);
  });

  it("is disabled only by the explicit value 'off'", () => {
    expect(patchEditsEnabled({ GAME_EDIT_PATCH: "off" })).toBe(false);
    expect(patchEditsEnabled({ GAME_EDIT_PATCH: "on" })).toBe(true);
  });

  it("GAME_EDIT_PATCH=off makes isGameEditTurn false even with a game to edit — the whole edit path disappears", () => {
    expect(isGameEditTurn("make the car faster", history)).toBe(true);
    process.env.GAME_EDIT_PATCH = "off";
    expect(isGameEditTurn("make the car faster", history)).toBe(false);
  });
});

// Penguin-maze session: the child pasted the identical request three times
// (msgs 13/15/19) because each reply claimed success without the change
// showing up. A repeat is a failure signal the model must be told about.
describe("isRepeatedRequest — the child sent the same message again", () => {
  it("is true when the message matches the last child message (whitespace/case-insensitive)", () => {
    const history = [msg("child", "I want the penguin to have  LEGS"), msg("assistant", GAME_V1)];
    expect(isRepeatedRequest("i want the penguin to have legs", history)).toBe(true);
  });

  it("is false for a different message", () => {
    const history = [msg("child", "add a jump button"), msg("assistant", GAME_V1)];
    expect(isRepeatedRequest("make the car faster", history)).toBe(false);
  });

  it("is false with no prior child message, and never true for a blank message", () => {
    expect(isRepeatedRequest("hello", [msg("assistant", "hi!")])).toBe(false);
    expect(isRepeatedRequest("   ", [msg("child", "   "), msg("assistant", GAME_V1)])).toBe(false);
  });
});

describe("REPEATED_REQUEST_SECTION — escalation instruction on a repeat", () => {
  it("tells the model the previous change did not work and to change approach, not re-claim success", () => {
    expect(REPEATED_REQUEST_SECTION).toMatch(/same (message|request)/i);
    expect(REPEATED_REQUEST_SECTION).toMatch(/did not work|didn't work|not.*work/i);
    expect(REPEATED_REQUEST_SECTION).toMatch(/different/i);
  });
});

describe("GAME_EDIT_STRICT_RETRY_SECTION — the hunks-only retry contract", () => {
  it("demands SEARCH/REPLACE blocks only and forbids a full document", () => {
    expect(GAME_EDIT_STRICT_RETRY_SECTION).toContain("<<<<<<< SEARCH");
    expect(GAME_EDIT_STRICT_RETRY_SECTION).toContain(">>>>>>> REPLACE");
    expect(GAME_EDIT_STRICT_RETRY_SECTION).toMatch(/no full|not.*full|never.*full/i);
  });

  it("gives the model an honest out for changes that genuinely need a rebuild", () => {
    expect(GAME_EDIT_STRICT_RETRY_SECTION).toContain("NEEDS_FULL_REBUILD");
  });
});

// Honest rebuild messaging: when the whole game WAS rebuilt, never show a
// bare "Added that!"-style line implying a targeted change — say a rebuild
// happened and invite the child to report anything that broke.
describe("regenReplyProse — kid-facing line when a whole rebuild was accepted", () => {
  it("keeps the model's own prose when it wrote some before the code", () => {
    const reply = "I made the maze 3D for you!\n```html\n<!doctype html><html><body>x</body></html>\n```";
    expect(regenReplyProse(reply)).toContain("I made the maze 3D for you!");
  });

  it("never leaks code or fences into the chat line", () => {
    const reply = "New version!\n```html\n<!doctype html><html><body>x</body></html>\n```";
    expect(regenReplyProse(reply)).not.toMatch(/```|<html|<!doctype/i);
  });

  it("falls back to the honest rebuilt-game line when the reply was code only", () => {
    const reply = "```html\n<!doctype html><html><body>x</body></html>\n```";
    expect(regenReplyProse(reply)).toBe(REBUILT_GAME_LINE);
    expect(REBUILT_GAME_LINE).toMatch(/rebuilt|whole game/i);
    expect(REBUILT_GAME_LINE).toMatch(/tell me/i);
  });

  it("handles an unfenced raw document the same way", () => {
    expect(regenReplyProse("<!doctype html><html><body>x</body></html>")).toBe(REBUILT_GAME_LINE);
  });
});

/** BUG-FIX-LOG 2026-07-18 follow-up: a malformed/truncated patch attempt
 *  (garbled markers, no closing REPLACE) was falling into "no patch found"
 *  and being shown to the child as literal raw text — "multiple blocks and
 *  not working code." looksLikeAttemptedEdit distinguishes a genuinely
 *  off-topic reply (safe to pass through as chat) from a mangled edit
 *  attempt (unsafe — must fall back to a full regeneration instead). */
describe("looksLikeAttemptedEdit — tells a malformed edit attempt apart from genuine off-topic chat", () => {
  it("is false for ordinary conversational text", () => {
    expect(looksLikeAttemptedEdit("Pandas eat bamboo! 🐼")).toBe(false);
  });

  it("is true for a truncated/incomplete patch attempt (opened SEARCH, never closed)", () => {
    expect(looksLikeAttemptedEdit("Sure, adding that now!\n<<<<<<< SEARCH\nconst x = 1;\n")).toBe(true);
  });

  it("is true when the reply carries a markdown code fence", () => {
    expect(looksLikeAttemptedEdit("Here's the updated part:\n```js\nconst x = 2;\n```")).toBe(true);
  });

  it("is true when the reply carries raw HTML/script tags", () => {
    expect(looksLikeAttemptedEdit("<script>doStuff()</script>")).toBe(true);
  });
});

/** Guards applyPatch()'s "regeneration" fallback (the model ignored the
 *  patch instruction and wrote a fenced/raw block instead): a PARTIAL
 *  snippet or "here's what changed" explanation must never be trusted as a
 *  whole-game replacement, or it silently replaces the entire game with a
 *  broken fragment. */
describe("looksLikeCompleteDocument — guards applyPatch's regeneration fallback", () => {
  it("is true for a real full document", () => {
    expect(looksLikeCompleteDocument("<!doctype html><html><body>game</body></html>")).toBe(true);
  });

  it("is false for a partial snippet with no <html> wrapper", () => {
    expect(looksLikeCompleteDocument("<div>just the changed part</div>")).toBe(false);
  });

  it("is false when the closing </html> is missing (truncated output)", () => {
    expect(looksLikeCompleteDocument("<html><body>cut off mid")).toBe(false);
  });
});

// BUG-FIX-LOG 2026-07-18 ("not kid friendly"): while an edit reply STREAMS,
// the raw accumulated text — "<<<<<<< SEARCH …" markers and code — was shown
// live in the chat bubble; the server-side prose split only fixes the FINAL
// message. The client must sanitize every partial render.
describe("streamingDisplayText — raw patch hunks never reach the bubble mid-stream", () => {
  it("passes plain prose through unchanged", () => {
    expect(streamingDisplayText("Adding your medic kit now!")).toBe("Adding your medic kit now!");
  });

  it("cuts at the first patch marker, keeping the prose plus a friendly working line", () => {
    const partial = "Adding your medic kit now!\n<<<<<<< SEARCH\nconst x = 1;";
    const shown = streamingDisplayText(partial);
    expect(shown).toContain("Adding your medic kit now!");
    expect(shown).toContain(EDIT_STREAM_WORKING_LINE);
    expect(shown).not.toContain("<<<");
    expect(shown).not.toContain("const x = 1;");
  });

  it("hides even a PARTIAL marker still arriving at the stream tail", () => {
    expect(streamingDisplayText("Sure!\n<<<<")).not.toContain("<<<<");
  });

  it("shows only the working line when the reply starts straight with hunks", () => {
    expect(streamingDisplayText("<<<<<<< SEARCH\nold")).toBe(EDIT_STREAM_WORKING_LINE);
  });
});
