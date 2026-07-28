// The gallery → chat handoff (docs/PRD-COMMUNITY-HELP.md §4.2).
import { describe, it, expect } from "vitest";
import { clearHelpAsk, loadHelpAsk, saveHelpAsk } from "./help-ask";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("help-ask handoff", () => {
  it("A.1 survives the navigation from /help back to the chat", () => {
    const s = fakeStorage();
    saveHelpAsk(s, "add a way to win my game");
    expect(loadHelpAsk(s)).toBe("add a way to win my game");
  });

  it("A.2 is consumed once — a reload must not rebuild the same game again", () => {
    const s = fakeStorage();
    saveHelpAsk(s, "add sounds");
    clearHelpAsk(s);
    expect(loadHelpAsk(s)).toBeNull();
  });

  it("A.3 expires, so an ask from hours ago never fires on the next visit", () => {
    const s = fakeStorage();
    saveHelpAsk(s, "add a boss");
    const later = Date.now() + 6 * 60 * 1000;
    expect(loadHelpAsk(s, later)).toBeNull();
  });

  it("A.4 nothing stored is null, and corrupt storage is null (never a crash)", () => {
    const s = fakeStorage();
    expect(loadHelpAsk(s)).toBeNull();
    s.setItem("kidgemini:help-ask:v1", "{oops");
    expect(loadHelpAsk(s)).toBeNull();
  });

  it("A.5 a storage that throws never breaks the gallery", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => saveHelpAsk(throwing, "x")).not.toThrow();
    expect(() => clearHelpAsk(throwing)).not.toThrow();
    expect(loadHelpAsk(throwing)).toBeNull();
  });

  it("A.6 an empty ask is ignored — a blank prompt would build nothing", () => {
    const s = fakeStorage();
    saveHelpAsk(s, "   ");
    expect(loadHelpAsk(s)).toBeNull();
  });
});
