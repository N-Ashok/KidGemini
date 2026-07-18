import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { trimHistory, findLastGameIndex, HISTORY_WINDOW, GAME_OMITTED_PLACEHOLDER } from "./history-trim";
import type { ChatMessage } from "@/types/chat.types";

let seq = 0;
function msg(role: "child" | "assistant", text: string): ChatMessage {
  seq += 1;
  return { id: `m${seq}`, role, text, createdAt: seq };
}

const GAME_V1 = "Here you go!\n```html\n<!doctype html><html><body>GAME V1 CODE</body></html>\n```";
const GAME_V2 = "Made it faster!\n```html\n<!doctype html><html><body>GAME V2 CODE</body></html>\n```";

describe("trimHistory — stale game HTML is stripped, the latest game survives", () => {
  it("keeps the newest game's code and replaces older versions with a placeholder", () => {
    const history = [
      msg("child", "make me a racing game"),
      msg("assistant", GAME_V1),
      msg("child", "make the car faster"),
      msg("assistant", GAME_V2),
    ];
    const out = trimHistory(history);
    expect(out).toHaveLength(4);
    expect(out[1]!.text).not.toContain("GAME V1 CODE");
    expect(out[1]!.text).toContain(GAME_OMITTED_PLACEHOLDER);
    expect(out[1]!.text).toContain("Here you go!"); // prose around the code survives
    expect(out[3]!.text).toContain("GAME V2 CODE"); // newest game intact
  });

  it("leaves plain conversation untouched", () => {
    const history = [
      msg("child", "what do pandas eat?"),
      msg("assistant", "Bamboo! Lots and lots of bamboo. 🐼"),
    ];
    expect(trimHistory(history)).toEqual(history);
  });

  it("strips unfenced raw-document games too (same tolerance as extractArtifact)", () => {
    const history = [
      msg("assistant", "<!doctype html><html><body>OLD RAW GAME</body></html>"),
      msg("child", "another one"),
      msg("assistant", GAME_V2),
    ];
    const out = trimHistory(history);
    expect(out[0]!.text).not.toContain("OLD RAW GAME");
    expect(out[2]!.text).toContain("GAME V2 CODE");
  });

  it("never touches child messages even if they pasted HTML", () => {
    const pasted = msg("child", "my file: ```html\n<html><body>KID PASTE</body></html>\n```");
    const out = trimHistory([pasted, msg("assistant", GAME_V2)]);
    expect(out[0]!.text).toContain("KID PASTE");
  });
});

describe("trimHistory — sliding window", () => {
  it(`caps history at the last ${HISTORY_WINDOW} messages`, () => {
    const history = Array.from({ length: 30 }, (_, i) =>
      msg(i % 2 === 0 ? "child" : "assistant", `turn ${i}`),
    );
    const out = trimHistory(history);
    expect(out).toHaveLength(HISTORY_WINDOW);
    expect(out[out.length - 1]!.text).toBe("turn 29");
  });

  it("re-includes the latest game message even when it falls outside the window", () => {
    const history: ChatMessage[] = [
      msg("child", "make me a game"),
      msg("assistant", GAME_V2), // the game — then lots of unrelated chat
      ...Array.from({ length: 20 }, (_, i) => msg(i % 2 === 0 ? "child" : "assistant", `chat ${i}`)),
    ];
    const out = trimHistory(history);
    // The game message is carried along so "update my game" still has the code…
    expect(out.some((m) => m.text.includes("GAME V2 CODE"))).toBe(true);
    // …and the window cap still holds (game rides IN the window, not on top of it).
    expect(out.length).toBeLessThanOrEqual(HISTORY_WINDOW);
    expect(out[out.length - 1]!.text).toBe("chat 19");
  });

  it("handles an empty history", () => {
    expect(trimHistory([])).toEqual([]);
  });
});

/** Exported so game-edit.ts can find "the current game to edit" without
 *  re-implementing the same rule a second time. */
describe("findLastGameIndex — the shared 'which message holds the current game' rule", () => {
  it("returns -1 when no game exists yet", () => {
    expect(findLastGameIndex([msg("child", "hi"), msg("assistant", "hello!")])).toBe(-1);
  });

  it("returns the index of the newest game when several exist", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V1), msg("child", "faster"), msg("assistant", GAME_V2)];
    expect(findLastGameIndex(history)).toBe(3);
  });

  it("ignores a child message that pasted HTML — only assistant messages count", () => {
    const pasted = msg("child", "my file: ```html\n<html><body>KID PASTE</body></html>\n```");
    expect(findLastGameIndex([pasted, msg("assistant", "just chatting, no game")])).toBe(-1);
  });
});

describe("findLastGameIndex / trimHistory - pinnedId (Continue from here)", () => {
  it("an earlier pinned game wins over a newer one", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V1), msg("child", "faster"), msg("assistant", GAME_V2)];
    expect(findLastGameIndex(history, history[1]!.id)).toBe(1);
  });

  it("trimHistory keeps the PINNED game's code, not the newest one's", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V1), msg("child", "faster"), msg("assistant", GAME_V2)];
    const out = trimHistory(history, history[1]!.id);
    expect(out[1]!.text).toContain("GAME V1 CODE");
    expect(out[3]!.text).not.toContain("GAME V2 CODE");
    expect(out[3]!.text).toContain(GAME_OMITTED_PLACEHOLDER);
  });

  it("falls back to the newest game when the pin names an id that isn't a game message", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V1), msg("child", "faster"), msg("assistant", GAME_V2)];
    expect(findLastGameIndex(history, history[0]!.id)).toBe(3);
  });

  it("falls back to the newest game when the pin names an id not present at all", () => {
    const history = [msg("assistant", GAME_V1), msg("assistant", GAME_V2)];
    expect(findLastGameIndex(history, "does-not-exist")).toBe(1);
  });
});

// BUG-FIX-LOG 2026-07-18 ("search_not_found on every edit turn"): a patch or
// fallback turn stores PROSE-ONLY text — the new game travels in the separate
// `artifactHtml` field. hasGame()/findLastGameIndex only looked at text, so
// from the second edit onward the model was shown an OLD version's code as
// "the current game", wrote SEARCH blocks against it, and applyPatch (which
// correctly reads the newest artifactHtml) could never match them. Live
// symptom: every edit turn logged `patch failed (search_not_found)` and fell
// back to a full regeneration built from the STALE version (a 3D game
// regressed to 2D). The model's view and applyPatch's target must be the
// same source: the artifactHtml FIELD.
describe("prose-only game messages (artifactHtml field, no code in text) — the patch-turn shape", () => {
  const NEW_GAME = "<!doctype html><html><body>PATCHED V3 CODE</body></html>";
  function proseMsg(text: string, artifactHtml: string): ChatMessage {
    seq += 1;
    return { id: `m${seq}`, role: "assistant", text, artifactHtml, createdAt: seq };
  }

  it("findLastGameIndex counts a prose-only assistant message that carries artifactHtml", () => {
    const history = [
      msg("child", "make a game"),
      msg("assistant", GAME_V1),
      msg("child", "add a medic kit"),
      proseMsg("Added the medic kit! 🎮", NEW_GAME),
    ];
    expect(findLastGameIndex(history)).toBe(3);
  });

  it("trimHistory re-inlines the current game's source from the field so the model can copy exact lines", () => {
    const history = [
      msg("child", "make a game"),
      msg("assistant", GAME_V1),
      msg("child", "add a medic kit"),
      proseMsg("Added the medic kit! 🎮", NEW_GAME),
    ];
    const out = trimHistory(history);
    expect(out[3]!.text).toContain("PATCHED V3 CODE"); // the model now SEES the true current source
    expect(out[3]!.text).toContain("Added the medic kit!"); // prose kept
    expect(out[1]!.text).not.toContain("GAME V1 CODE"); // older version still stripped
    expect(out[1]!.text).toContain(GAME_OMITTED_PLACEHOLDER);
  });

  it("an OLDER prose-only game message is stripped to prose + placeholder like any stale version", () => {
    const history = [
      msg("child", "make a game"),
      proseMsg("Added the medic kit! 🎮", NEW_GAME),
      msg("child", "faster"),
      msg("assistant", GAME_V2),
    ];
    const out = trimHistory(history);
    expect(out[1]!.text).not.toContain("PATCHED V3 CODE");
    expect(out[1]!.text).toContain(GAME_OMITTED_PLACEHOLDER);
    expect(out[3]!.text).toContain("GAME V2 CODE");
  });

  it("a pinned prose-only game message wins and gets its source re-inlined", () => {
    const pinned = proseMsg("Added the medic kit! 🎮", NEW_GAME);
    const history = [msg("child", "make a game"), pinned, msg("child", "faster"), msg("assistant", GAME_V2)];
    const out = trimHistory(history, pinned.id);
    expect(out[1]!.text).toContain("PATCHED V3 CODE");
    expect(out[3]!.text).not.toContain("GAME V2 CODE");
  });

  it("a message whose text ALREADY carries the code is not double-inlined", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V2)];
    const out = trimHistory(history);
    expect(out[1]!.text.match(/GAME V2 CODE/g)).toHaveLength(1);
  });
});
