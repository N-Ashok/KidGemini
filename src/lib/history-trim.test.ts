import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { trimHistory, HISTORY_WINDOW, GAME_OMITTED_PLACEHOLDER } from "./history-trim";
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
