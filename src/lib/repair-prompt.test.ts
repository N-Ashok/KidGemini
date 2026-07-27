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

  // BUG-FIX-LOG 2026-07-23 (owner UAT, "remove the leaderboard" left the word +
  // raw markers in the saved New Testament quiz): the model wrapped a
  // HALF-PATCHED game in a ```html fence, leaving SEARCH/REPLACE conflict markers
  // INSIDE the document. The regeneration fallback stored it verbatim, so the
  // game shipped corrupted (markers inside <style>, edit never took). A "full
  // document" that still carries conflict markers is NOT a clean game — reject it
  // so the route falls back to a real full regeneration.
  it("rejects a fenced document that still contains raw SEARCH/REPLACE conflict markers", () => {
    const reply =
      "```html\n<!doctype html><html><head><style>#x{color:red}\n\n" +
      ">>>>>>> REPLACE\n<<<<<<< SEARCH\n" +
      '<div id="leaderboard">Leaderboard</div>\n=======\n' +
      "</style></head><body>game</body></html>\n```";
    expect(applyPatch(html, reply)).toEqual({ ok: false, reason: "conflict_markers" });
  });

  it("rejects an UNFENCED full document carrying MALFORMED conflict markers too", () => {
    // Reversed/partial markers (REPLACE before SEARCH, no closing REPLACE) — the
    // real corruption shape — don't form a valid PATCH_RE block, so they reach
    // the regeneration fallback and must be rejected there.
    const reply = "<!doctype html><html><body>x\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ny\n=======\nz</body></html>";
    expect(applyPatch(html, reply)).toEqual({ ok: false, reason: "conflict_markers" });
  });
});

// Whitespace-tolerant fallback matching (KNOWN_BUGS #5 class fix, 2026-07-27):
// production evidence showed 84% of full-rebuild triggers were search_not_found
// on ordinary small edits ("fix the tank color", "the road corner looks
// inverted") — not big asks. The model transcribes SEARCH text from a large
// file it "remembers" rather than sees verbatim, and a single whitespace slip
// (extra space, different indentation, a dropped trailing space) made the
// exact byte-for-byte match fail and threw away the whole game to rebuild it.
// This fallback tolerates whitespace-only drift while still requiring every
// actual letter/word/punctuation character to match exactly — it must never
// turn a genuinely wrong SEARCH into a false "found".
describe("applyPatch — whitespace-tolerant fallback (KNOWN_BUGS #5 class fix, 2026-07-27)", () => {
  it("matches when the model collapses a run of spaces the source has around an operator", () => {
    // Whitespace RUNS collapse (one-or-more spaces treated alike) — but the
    // fallback deliberately does NOT insert or remove a space that isn't
    // there at all (see the case-sensitive-style test below): that would risk
    // gluing tokens together, the exact class of bug the PROFANITY word-token
    // matcher (safety.rules.ts) was hardened against ("medic kit" -> "medickit").
    const src = "<script>let carSpeed  =  5;\nif(keys.up)car.y-=carSpeed;</script>";
    const reply = "<<<<<<< SEARCH\nlet carSpeed = 5;\n=======\nlet carSpeed = 9;\n>>>>>>> REPLACE";
    const r = applyPatch(src, reply);
    expect(r).toMatchObject({ ok: true, mode: "patch" });
    if (r.ok) {
      expect(r.html).toContain("carSpeed = 9;");
      expect(r.html).toContain("car.y-=carSpeed;"); // untouched code stays untouched
    }
  });

  it("matches when the model re-indents a multi-line SEARCH block differently than the source", () => {
    const src = "<script>\nfunction tick(){\n  if(alive){\n    score++;\n  }\n}\n</script>";
    const reply =
      "<<<<<<< SEARCH\nif(alive){\n  score++;\n}\n=======\nif(alive){\n  score += 2;\n}\n>>>>>>> REPLACE";
    const r = applyPatch(src, reply);
    expect(r).toMatchObject({ ok: true, mode: "patch" });
    if (r.ok) expect(r.html).toContain("score += 2;");
  });

  it("matches when the model drops a trailing space the source has", () => {
    const src = "<style>.car { color: red; } \n.track { color: gray; }</style>";
    const reply = "<<<<<<< SEARCH\n.car { color: red; }\n=======\n.car { color: blue; }\n>>>>>>> REPLACE";
    const r = applyPatch(src, reply);
    expect(r).toMatchObject({ ok: true, mode: "patch" });
    if (r.ok) expect(r.html).toContain("color: blue");
  });

  it("still fails closed when the text is genuinely different, not just re-whitespaced", () => {
    const src = "<script>let carSpeed = 5;</script>";
    const reply = "<<<<<<< SEARCH\nlet boatSpeed = 5;\n=======\nlet boatSpeed = 9;\n>>>>>>> REPLACE";
    expect(applyPatch(src, reply)).toEqual({ ok: false, reason: "search_not_found" });
  });

  it("is case-sensitive — the fallback tolerates whitespace, never letter case", () => {
    const src = "<script>let CarSpeed = 5;</script>";
    const reply = "<<<<<<< SEARCH\nlet carSpeed = 5;\n=======\nlet carSpeed = 9;\n>>>>>>> REPLACE";
    expect(applyPatch(src, reply)).toEqual({ ok: false, reason: "search_not_found" });
  });

  it("reports ambiguous when whitespace-collapsing makes two DIFFERENT-looking spots identical", () => {
    // Neither line matches SEARCH byte-for-byte (both have an extra space
    // somewhere), so the exact pass finds nothing and falls to the fuzzy
    // pass — where both collapse to the same normalized text.
    const src = "<script>let  x = 1;\nlet x  = 1;</script>";
    const reply = "<<<<<<< SEARCH\nlet x = 1;\n=======\nlet x = 2;\n>>>>>>> REPLACE";
    expect(applyPatch(src, reply)).toEqual({ ok: false, reason: "search_ambiguous" });
  });

  it("prefers an exact match over the fuzzy fallback when both exist", () => {
    // "let x=1;" appears exactly once verbatim, and a whitespace-different
    // sibling also exists — the exact one must win, not get flagged ambiguous.
    const src = "<script>let x=1;\nlet  x = 1;</script>";
    const reply = "<<<<<<< SEARCH\nlet x=1;\n=======\nlet x=2;\n>>>>>>> REPLACE";
    const r = applyPatch(src, reply);
    expect(r).toMatchObject({ ok: true, mode: "patch" });
    if (r.ok) {
      expect(r.html).toContain("let x=2;");
      expect(r.html).toContain("let  x = 1;"); // the other one, untouched
    }
  });
});
