// Copyable error report for "something unexpected happened" (owner request
// 2026-07-20: the console tab was hidden from kids in the self-healing
// preview work, which also removed the grown-up's only way to COPY an error
// when a game breaks). Pure formatter — the UI just renders/copies it.
import { describe, it, expect } from "vitest";
import { buildErrorReport, hasExtremeError, MAX_REPORT_CHARS } from "./error-report";
import type { GameConsoleMessage } from "@/types/game-console.types";

const err = (over: Partial<GameConsoleMessage> = {}): GameConsoleMessage => ({
  level: "error",
  kind: "error",
  text: "TypeError: boom (game.html:42:10)",
  filename: "game.html",
  line: 42,
  col: 10,
  stack: "TypeError: boom\n  at loop (game.html:42:10)\n  at raf (game.html:9:3)",
  ...over,
});

describe("hasExtremeError — when the details affordance appears at all", () => {
  it("true when the game threw, or when verify gave up", () => {
    expect(hasExtremeError({ outcome: "clean", errors: [err()] })).toBe(true);
    expect(hasExtremeError({ outcome: "failed", errors: [] })).toBe(true);
    expect(hasExtremeError({ outcome: "bailed", errors: [] })).toBe(true);
  });

  it("false for a healthy game — a kid never meets this UI on a working game", () => {
    expect(hasExtremeError({ outcome: "clean", errors: [] })).toBe(false);
    expect(hasExtremeError({ outcome: "repaired", errors: [] })).toBe(false);
    expect(hasExtremeError({ outcome: null, errors: [] })).toBe(false);
  });

  it("plain console.log/warn noise is NOT an extreme error", () => {
    expect(hasExtremeError({ outcome: "clean", errors: [err({ level: "log", kind: undefined })] })).toBe(false);
    expect(hasExtremeError({ outcome: "clean", errors: [err({ level: "warn", kind: undefined })] })).toBe(false);
  });
});

describe("buildErrorReport", () => {
  const base = { gameTitle: "Race!", outcome: "failed" as const, failureCode: "load_error", userAgent: "Mozilla/5.0 (Macintosh)" };

  it("carries everything needed to diagnose: title, verdict, error text, stack, browser", () => {
    const out = buildErrorReport({ ...base, errors: [err()] });
    expect(out).toContain("Race!");
    expect(out).toContain("load_error");
    expect(out).toContain("TypeError: boom");
    expect(out).toContain("at loop (game.html:42:10)");
    expect(out).toContain("Mozilla/5.0 (Macintosh)");
  });

  it("numbers multiple errors and keeps resource 404 URLs", () => {
    const out = buildErrorReport({
      ...base,
      errors: [err(), err({ kind: "resource", text: "Failed to load: https://cdn.x/a.js", url: "https://cdn.x/a.js", stack: undefined })],
    });
    expect(out).toContain("1.");
    expect(out).toContain("2.");
    expect(out).toContain("https://cdn.x/a.js");
  });

  it("says so plainly when the game threw nothing (verify gave up on its own)", () => {
    const out = buildErrorReport({ ...base, errors: [] });
    expect(out).toMatch(/no error messages/i);
  });

  it("is bounded — a runaway error flood can never produce an unpastable wall of text", () => {
    const flood = Array.from({ length: 200 }, (_, i) => err({ text: `boom ${i}`, stack: "x\n".repeat(50) }));
    const out = buildErrorReport({ ...base, errors: flood });
    expect(out.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
    expect(out).toContain("boom 0"); // the FIRST errors are the diagnostic ones
  });

  it("never includes the game's source code (a report is pasted into chats)", () => {
    const out = buildErrorReport({ ...base, errors: [err()], });
    expect(out).not.toContain("<!doctype");
    expect(out).not.toContain("<script");
  });
});
