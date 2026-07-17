import { describe, expect, it } from "vitest";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "./sidebar-pane";

function fakeStorage(init: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(init));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("sidebar collapse persistence — same never-throw contract as chat-store", () => {
  it("round-trips a saved collapsed state", () => {
    const s = fakeStorage();
    saveSidebarCollapsed(s, true);
    expect(loadSidebarCollapsed(s)).toBe(true);
    saveSidebarCollapsed(s, false);
    expect(loadSidebarCollapsed(s)).toBe(false);
  });

  it("defaults to expanded (false) when nothing was ever saved", () => {
    expect(loadSidebarCollapsed(fakeStorage())).toBe(false);
  });

  it("defaults to expanded on garbage values", () => {
    expect(loadSidebarCollapsed(fakeStorage({ "kidgemini:sidebar-collapsed:v1": "banana" }))).toBe(false);
  });

  it("save never throws (quota / private mode)", () => {
    const s = fakeStorage();
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => saveSidebarCollapsed(s, true)).not.toThrow();
  });

  it("load never throws (quota / private mode)", () => {
    const s = fakeStorage();
    s.getItem = () => {
      throw new Error("SecurityError");
    };
    expect(() => loadSidebarCollapsed(s)).not.toThrow();
    expect(loadSidebarCollapsed(s)).toBe(false);
  });
});
