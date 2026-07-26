/** Deterministic file-open (BUG-FIX-LOG 2026-07-26): a complete HTML upload
 *  opens in the preview DIRECTLY — the model must never see an "open the
 *  file" turn (it regenerates the game and hallucinates additions). These
 *  tests pin the decision logic; the container only executes the plan. */
import { describe, it, expect } from "vitest";
import { isCompleteHtmlDocument, isOpenOnlyRequest, fileOpenPlan, openedFileLine, uploadHistoryLine } from "./file-open";

const GAME = "<!doctype html><html><body><canvas></canvas></body></html>";

describe("isCompleteHtmlDocument", () => {
  it("recognizes a doctype document and a bare <html> document", () => {
    expect(isCompleteHtmlDocument(GAME)).toBe(true);
    expect(isCompleteHtmlDocument("<html lang='en'><body>hi</body></html>")).toBe(true);
    expect(isCompleteHtmlDocument("  \n<!DOCTYPE HTML>\n<html>…")).toBe(true);
  });

  it("rejects fragments and non-HTML code — those still go to the model", () => {
    expect(isCompleteHtmlDocument("<div>just a fragment</div>")).toBe(false);
    expect(isCompleteHtmlDocument("function jump() { y += 10; }")).toBe(false);
    expect(isCompleteHtmlDocument("# my notes")).toBe(false);
    expect(isCompleteHtmlDocument("")).toBe(false);
  });
});

describe("isOpenOnlyRequest", () => {
  it("empty text is open-only (bare upload just opens)", () => {
    expect(isOpenOnlyRequest("")).toBe(true);
    expect(isOpenOnlyRequest("   ")).toBe(true);
  });

  it("open/show/run/play phrasings are open-only — the exact reported case included", () => {
    for (const t of [
      "open the file",
      "Open it",
      "please open my file",
      "can you open the game",
      "show me the game",
      "run it",
      "play my game",
      "load the file please",
      "preview it now",
    ]) {
      expect(isOpenOnlyRequest(t), t).toBe(true);
    }
  });

  it("real change requests are NOT open-only — they must reach the model as edits", () => {
    for (const t of [
      "make it faster",
      "open a shop in the game", // contains 'open' but is an edit ask
      "open the file and add a boss level",
      "fix the jump button",
      "why does it crash",
    ]) {
      expect(isOpenOnlyRequest(t), t).toBe(false);
    }
  });
});

describe("fileOpenPlan", () => {
  it("no attachment / image / non-HTML text file → model path unchanged", () => {
    expect(fileOpenPlan(undefined, "open the file").mode).toBe("model");
    expect(fileOpenPlan({ kind: "image" }, "open it").mode).toBe("model");
    expect(fileOpenPlan({ kind: "text", content: "function f() {}" }, "open the file").mode).toBe("model");
  });

  it("complete HTML + open-ish/empty text → open-only (NO model call)", () => {
    const p = fileOpenPlan({ kind: "text", content: GAME }, "open the file");
    expect(p).toEqual({ mode: "open-only", html: GAME });
    expect(fileOpenPlan({ kind: "text", content: GAME }, "")).toEqual({ mode: "open-only", html: GAME });
  });

  it("complete HTML + a real request → open first, then edit against the opened game", () => {
    const p = fileOpenPlan({ kind: "text", content: GAME }, "make the player faster");
    expect(p).toEqual({ mode: "open-then-edit", html: GAME });
  });
});

describe("chat copy", () => {
  it("openedFileLine names the file; uploadHistoryLine differs from any kid ask (repeated-request guard)", () => {
    expect(openedFileLine("maze.html")).toContain("maze.html");
    // The history stand-in must never equal the kid's typed text, or the
    // server's isRepeatedRequest would see an exact re-send and misfire.
    expect(uploadHistoryLine("maze.html")).not.toBe("make the player faster");
    expect(uploadHistoryLine("maze.html")).toContain("maze.html");
  });
});
