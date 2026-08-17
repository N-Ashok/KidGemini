import { describe, it, expect } from "vitest";
import { formatRepairErrorSummary } from "./game-console";
import type { GameConsoleMessage } from "@/types/game-console.types";

const msg = (m: Partial<GameConsoleMessage>): GameConsoleMessage =>
  ({ level: "log", text: "", ...m }) as GameConsoleMessage;

describe("formatRepairErrorSummary", () => {
  it("E.1 reports the error TEXT, not [object Object] (the reported bug)", () => {
    const out = formatRepairErrorSummary([
      msg({ level: "error", kind: "error", text: "THREE.CapsuleGeometry is not a constructor" }),
    ]);
    expect(out).toContain("THREE.CapsuleGeometry is not a constructor");
    expect(out).not.toContain("[object Object]");
  });

  it("E.2 skips a leading console.log and reports the real error", () => {
    const out = formatRepairErrorSummary([
      msg({ level: "log", text: "game booting" }),
      msg({ level: "error", kind: "error", text: "x is not defined" }),
    ]);
    expect(out).toContain("x is not defined");
    expect(out).not.toContain("game booting");
  });

  it("E.3 includes file and line when the browser gave them", () => {
    const out = formatRepairErrorSummary([
      msg({ level: "error", kind: "error", text: "boom", filename: "https://x.test/game.html", line: 42 }),
    ]);
    expect(out).toContain("game.html:42");
  });

  it("E.4 counts the remaining messages", () => {
    const out = formatRepairErrorSummary([
      msg({ level: "error", kind: "error", text: "boom" }),
      msg({ level: "log", text: "a" }),
      msg({ level: "log", text: "b" }),
    ]);
    expect(out).toContain("(+2 more)");
  });

  it("E.5 catches an unhandled rejection too", () => {
    const out = formatRepairErrorSummary([msg({ level: "error", kind: "rejection", text: "fetch failed" })]);
    expect(out).toContain("fetch failed");
  });

  it("E.6 says err=none for no errors, and for console noise only", () => {
    expect(formatRepairErrorSummary([])).toBe(" err=none");
    expect(formatRepairErrorSummary(undefined)).toBe(" err=none");
    expect(formatRepairErrorSummary([msg({ level: "log", text: "just a log" })])).toBe(" err=none");
  });

  it("E.7 collapses newlines and truncates — one grep-able line", () => {
    const out = formatRepairErrorSummary([msg({ level: "error", kind: "error", text: "a\n  b\n\tc" })]);
    expect(out).toContain("a b c");
    expect(out).not.toContain("\n");
    const long = formatRepairErrorSummary([msg({ level: "error", kind: "error", text: "z".repeat(500) })]);
    expect(long.length).toBeLessThan(200);
  });
});
