import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { trimHistory, findLastGameIndex, HISTORY_WINDOW, HISTORY_HYSTERESIS, GAME_OMITTED_PLACEHOLDER } from "./history-trim";
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
    // 2026-08-25 PRD_EditTurnCost §4.A: the NEWEST game is stripped too — its
    // source rides the final user turn (gemini.ts gameSourceBlock), never the
    // history, so the 10–25k-token blob can no longer bust the cache prefix.
    expect(out[3]!.text).not.toContain("GAME V2 CODE");
    expect(out[3]!.text).toContain(GAME_OMITTED_PLACEHOLDER);
    expect(out[3]!.artifactHtml).toContain("GAME V2 CODE"); // …but the source is still ON the message for the tail
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
    expect(out[2]!.text).not.toContain("GAME V2 CODE"); // tail carries it (2026-08-25)
    expect(out[2]!.artifactHtml).toContain("GAME V2 CODE");
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
    expect(out.some((m) => m.artifactHtml?.includes("GAME V2 CODE"))).toBe(true);
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
    // Neither game is inlined any more; the PINNED source is what the tail
    // carries (gemini.ts currentGameHtml(history, pinnedId)) — pinned here.
    expect(out[1]!.artifactHtml).toContain("GAME V1 CODE");
    expect(out[1]!.text).not.toContain("GAME V1 CODE");
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
    expect(out[3]!.text).not.toContain("PATCHED V3 CODE"); // source rides the tail, not the history (2026-08-25)
    expect(out[3]!.artifactHtml).toContain("PATCHED V3 CODE"); // the tail reads it from here
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
    expect(out[3]!.text).not.toContain("GAME V2 CODE");
    expect(out[3]!.artifactHtml).toContain("GAME V2 CODE");
  });

  it("a pinned prose-only game message wins and gets its source re-inlined", () => {
    const pinned = proseMsg("Added the medic kit! 🎮", NEW_GAME);
    const history = [msg("child", "make a game"), pinned, msg("child", "faster"), msg("assistant", GAME_V2)];
    const out = trimHistory(history, pinned.id);
    expect(out[1]!.text).not.toContain("PATCHED V3 CODE"); // pinned source rides the tail too
    expect(out[1]!.artifactHtml).toContain("PATCHED V3 CODE");
    expect(out[3]!.text).not.toContain("GAME V2 CODE");
  });

  it("a message whose text ALREADY carries the code is not double-inlined", () => {
    const history = [msg("child", "make a game"), msg("assistant", GAME_V2)];
    const out = trimHistory(history);
    expect(out[1]!.text).not.toContain("GAME V2 CODE"); // stripped like every other game message
    expect(out[1]!.artifactHtml).toContain("GAME V2 CODE");
  });
});

// 2026-08-25 PRD_EditTurnCost §4.A (PRD-PROMPT-CACHING Fix A+B): the request
// prefix must be byte-stable between consecutive turns or Gemini's implicit
// cache never hits (measured 2–4% in prod). Two rules make it stable:
//   1. the window cuts in BLOCKS (hysteresis), not by one message per turn;
//   2. game code never sits in history — every game message is a fixed
//      placeholder, and the current source rides the final user turn.
describe("trimHistory — byte-stable prefix (hysteresis window, no game code in history)", () => {
  const convo = (n: number) => Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? "child" : "assistant", `turn ${i}`));

  it("H.1 does NOT cut while history is within WINDOW + HYSTERESIS", () => {
    const history = convo(HISTORY_WINDOW + HISTORY_HYSTERESIS);
    expect(trimHistory(history)).toHaveLength(HISTORY_WINDOW + HISTORY_HYSTERESIS);
  });

  it("H.2 cuts back to WINDOW once history exceeds WINDOW + HYSTERESIS", () => {
    const history = convo(HISTORY_WINDOW + HISTORY_HYSTERESIS + 1);
    const out = trimHistory(history);
    expect(out).toHaveLength(HISTORY_WINDOW);
    expect(out[out.length - 1]!.text).toBe(`turn ${HISTORY_WINDOW + HISTORY_HYSTERESIS}`);
  });

  it("H.3 between cuts, turn N+1's trimmed history is turn N's plus the two new messages (prefix identical)", () => {
    const base = [msg("child", "make me a game"), msg("assistant", GAME_V1), ...convo(6)];
    const turnN = trimHistory(base);
    const turnN1 = trimHistory([...base, msg("child", "make it faster"), msg("assistant", GAME_V2)]);
    expect(turnN1.slice(0, turnN.length)).toEqual(turnN);
  });

  it("H.4 a game message's placeholder text is the SAME bytes whether or not it is the current game (a newer game must not rewrite an older message)", () => {
    const g1 = msg("assistant", GAME_V1);
    const before = trimHistory([msg("child", "make me a game"), g1]);
    const after = trimHistory([msg("child", "make me a game"), g1, msg("child", "faster"), msg("assistant", GAME_V2)]);
    expect(after[1]!.text).toBe(before[1]!.text);
  });

  it("H.5 a game that lived only in the text (no artifactHtml field) is lifted onto artifactHtml so the tail can still carry it", () => {
    const out = trimHistory([msg("child", "make me a game"), msg("assistant", GAME_V1)]);
    expect(out[1]!.artifactHtml).toContain("GAME V1 CODE");
    expect(out[1]!.text).not.toContain("GAME V1 CODE");
  });

  it("H.6 the current game message is still carried when it falls off the window (edit detection needs it)", () => {
    const history: ChatMessage[] = [
      msg("child", "make me a game"),
      msg("assistant", GAME_V2),
      ...convo(HISTORY_WINDOW + HISTORY_HYSTERESIS + 4),
    ];
    const out = trimHistory(history);
    expect(out.length).toBeLessThanOrEqual(HISTORY_WINDOW);
    expect(findLastGameIndex(out)).not.toBe(-1);
    expect(out[findLastGameIndex(out)]!.artifactHtml).toContain("GAME V2 CODE");
  });
});
