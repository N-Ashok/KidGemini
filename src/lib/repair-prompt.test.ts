// PRD §13 rows R.1, R.4, R.5, R.6 — repair prompt construction and the
// minimal-patch application.
import { describe, it, expect } from "vitest";
import {
  REPAIR_TAXONOMY,
  applyPatch,
  buildRepairPrompt,
  exhaustedQuestion,
} from "./repair-prompt";
import type { VerifyEvidence } from "@/types/preview-verify.types";

const evidence = (over: Partial<VerifyEvidence>): VerifyEvidence => ({
  rafCountAtSettle: 0,
  rafCountFinal: 0,
  canvas: null,
  pixel: null,
  start: null,
  ...over,
});

describe("buildRepairPrompt", () => {
  it("R.1 — start_occluded names the occluding selector and pointer-events, and protects the handler", () => {
    const p = buildRepairPrompt({
      failureCode: "start_occluded",
      evidence: evidence({ start: { found: true, x: 200, y: 220, occluded: true, occluder: "div.overlay", clickRafDelta: 0 } }),
      errors: [],
      originalRequest: "a ghost maze game",
      html: "<html></html>",
    });
    expect(p).toContain("div.overlay");
    expect(p).toContain("pointer-events: none");
    expect(p).toContain("Do NOT change the button's click handler");
  });

  it("R.5 — every repair prompt carries the kid's original request", () => {
    for (const code of Object.keys(REPAIR_TAXONOMY) as Array<keyof typeof REPAIR_TAXONOMY>) {
      const p = buildRepairPrompt({
        failureCode: code,
        evidence: evidence({}),
        errors: [{ level: "error", text: "boom (g.html:2:1)", kind: "error", filename: "g.html", line: 2, stack: "Error at init" }],
        originalRequest: "a dino racing game with turbo",
        html: "<html></html>",
      });
      expect(p).toContain("a dino racing game with turbo");
      expect(p).toContain(`Failure: ${code}`);
    }
  });

  it("load_error carries message, location and stack — the stack is the fix", () => {
    const p = buildRepairPrompt({
      failureCode: "load_error",
      evidence: evidence({}),
      errors: [{ level: "error", text: "TypeError: x undefined (game.html:247:3)", kind: "error", filename: "game.html", line: 247, stack: "TypeError\n at gameLoop (game.html:247:3)" }],
      originalRequest: "a game",
      html: "<html></html>",
    });
    expect(p).toContain("game.html:247");
    expect(p).toContain("at gameLoop");
  });

  it("R.4 — the exhausted-repair message is a question with no stack/console leakage", () => {
    const q = exhaustedQuestion();
    expect(q).toMatch(/\?|!/);
    expect(q.toLowerCase()).not.toContain("stack");
    expect(q.toLowerCase()).not.toContain("console");
    expect(q.toLowerCase()).not.toContain("error");
  });

  it("every taxonomy entry has a kid-facing line free of jargon", () => {
    for (const entry of Object.values(REPAIR_TAXONOMY)) {
      expect(entry.kidLine.length).toBeGreaterThan(0);
      expect(entry.kidLine.toLowerCase()).not.toMatch(/stack|console|exception|undefined/);
    }
  });
});

describe("applyPatch (R.6 — patch, not regeneration)", () => {
  const html = "<html><style>.overlay{pointer-events:auto}</style><body>game</body></html>";

  it("applies a single SEARCH/REPLACE block surgically", () => {
    const reply = "<<<<<<< SEARCH\n.overlay{pointer-events:auto}\n=======\n.overlay{pointer-events:none}\n>>>>>>> REPLACE";
    const r = applyPatch(html, reply);
    expect(r).toMatchObject({ ok: true, mode: "patch" });
    if (r.ok) {
      expect(r.html).toContain("pointer-events:none");
      expect(r.html).toContain("<body>game</body>"); // everything else untouched
    }
  });

  it("applies multiple blocks in order", () => {
    const reply = [
      "<<<<<<< SEARCH\n.overlay{pointer-events:auto}\n=======\n.overlay{pointer-events:none}\n>>>>>>> REPLACE",
      "<<<<<<< SEARCH\n<body>game</body>\n=======\n<body>game on</body>\n>>>>>>> REPLACE",
    ].join("\n");
    const r = applyPatch(html, reply);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toContain("game on");
  });

  it("fails closed when the SEARCH text is not in the source", () => {
    const reply = "<<<<<<< SEARCH\nnot in the file\n=======\nx\n>>>>>>> REPLACE";
    expect(applyPatch(html, reply)).toEqual({ ok: false, reason: "search_not_found" });
  });

  it("fails closed when the SEARCH text is ambiguous (matches twice)", () => {
    const doubled = "<p>hi</p><p>hi</p>";
    const reply = "<<<<<<< SEARCH\n<p>hi</p>\n=======\n<p>yo</p>\n>>>>>>> REPLACE";
    expect(applyPatch(doubled, reply)).toEqual({ ok: false, reason: "search_ambiguous" });
  });

  it("falls back to a full ```html document (counts as regeneration)", () => {
    const reply = "Here you go!\n```html\n<!doctype html><html><body>fixed</body></html>\n```";
    const r = applyPatch(html, reply);
    expect(r).toMatchObject({ ok: true, mode: "regeneration" });
    if (r.ok) expect(r.html).toContain("fixed");
  });

  it("rejects a reply with neither patch nor document", () => {
    expect(applyPatch(html, "Sorry, I cannot help with that.")).toEqual({ ok: false, reason: "no_patch_in_reply" });
  });
});
