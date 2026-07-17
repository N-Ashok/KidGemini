import { describe, expect, it } from "vitest";
import { saveChats } from "./chat-store";
import {
  defaultRenameNoticeStore,
  loadRenameNotice,
  saveRenameNotice,
  shouldShowRenameNotice,
} from "./rename-notice";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

const greetingOnly = (id: string) => ({
  id,
  title: "New chat",
  messages: [{ id: "m1", role: "assistant", text: "Hi! Ask me anything.", createdAt: 1 }],
});

const realConvo = (id: string) => ({
  id,
  title: `Chat ${id}`,
  messages: [
    { id: "m1", role: "assistant", text: "Hi!", createdAt: 1 },
    { id: "m2", role: "user", text: "make me a game", createdAt: 2 },
  ],
});

describe("rename-notice — one-time 'KidGemini is now Ari' banner (2026-07-17)", () => {
  it("never shows to a device with no saved chats at all (brand-new visitor)", () => {
    const s = fakeStorage();
    expect(shouldShowRenameNotice(s, defaultRenameNoticeStore())).toBe(false);
  });

  it("never shows to a device whose only chat is the unsent greeting (never knew the old name)", () => {
    const s = fakeStorage();
    saveChats(s, [greetingOnly("a")] as never, "a");
    expect(shouldShowRenameNotice(s, defaultRenameNoticeStore())).toBe(false);
  });

  it("shows to a returning device with real prior history", () => {
    const s = fakeStorage();
    saveChats(s, [realConvo("a")] as never, "a");
    expect(shouldShowRenameNotice(s, defaultRenameNoticeStore())).toBe(true);
  });

  it("never shows again once marked seen, even with real history present", () => {
    const s = fakeStorage();
    saveChats(s, [realConvo("a")] as never, "a");
    expect(shouldShowRenameNotice(s, { seen: true })).toBe(false);
  });

  it("round-trips the seen flag through save/load", () => {
    const s = fakeStorage();
    saveRenameNotice(s, { seen: true });
    expect(loadRenameNotice(s)).toEqual({ seen: true });
  });

  it("load defaults to unseen on absent/garbage data (fail-open — the notice is harmless to show)", () => {
    const s = fakeStorage();
    expect(loadRenameNotice(s)).toEqual({ seen: false });
    s.setItem("ari:rename-notice:v1", "not json");
    expect(loadRenameNotice(s)).toEqual({ seen: false });
  });

  it("save never throws (quota / private mode)", () => {
    const s = fakeStorage();
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => saveRenameNotice(s, { seen: true })).not.toThrow();
  });
});
