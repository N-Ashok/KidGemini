// PRD §13 rows R.1, R.4, R.5, R.6 — repair prompt construction and the
// minimal-patch application.
import { describe, it, expect } from "vitest";
import {
  REPAIR_TAXONOMY,
  REPAIR_SYSTEM_PROMPT,
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
      // The failure CODE must be named; the surrounding wording changed on
      // 2026-08-17 when the prompt was reordered to source-first (B1 below),
      // so this pins the fact, not the phrasing.
      expect(p).toContain(code);
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


// ── B1: the repair's FIRST attempt produced no patch, 5 times out of 5 ──────
//
// 2026-08-17, KNOWN_BUGS #23(b). Every observed repair in production logged
// `rescued by strict retry (first: no_patch_in_reply)`. `no_patch_in_reply`
// means the reply contained neither a SEARCH/REPLACE block NOR a full document
// — i.e. the model answered in prose. So the first call was a wasted model
// call (~3s and the child's Sparks) on EVERY single repair, and the rescue
// rung did 100% of the work.
//
// Ruled out first: it is not a truncated thinking phase. GEN_CONFIG sets
// `thinkingBudget: 0`, so the 4096-token output budget is all visible text.
//
// What is left is the CONTRACT, and there is a controlled comparison sitting
// in the same codebase. `GAME_EDIT_STRICT_RETRY_SECTION` asks for the same
// SEARCH/REPLACE format from the same models and demonstrably WORKS — it is
// what rescues these very repairs. It differs in three ways, all of which the
// repair prompt now adopts:
//
//   1. SOURCE FIRST, instruction LAST. The repair prompt put the diagnosis at
//      the top and then ~15k tokens of game HTML, so the model's context ENDED
//      on raw markup with the instruction far behind it. The working contract
//      ends on the ask.
//   2. It permits ONE short sentence before the blocks. The repair prompt said
//      "No prose", and a model that opens with a helpful sentence has then
//      already broken the contract — prose-only is a short step from there.
//   3. It gives an ESCAPE HATCH. The repair prompt forbade returning a full
//      file, while `applyPatch` has always ACCEPTED one (mode:"regeneration").
//      Forbidding the fallback its own applier supports means a model that
//      cannot patch has no valid output left, so it explains instead.
//
// HYPOTHESIS, stated as one: this is reasoned from a controlled in-repo
// comparison and from production log counts, not from a live A/B. What proves
// it is `stage=strict_retry rescued=true` becoming rare in the logs (see
// docs/LOGGING.md). Until then the rescue rung still catches everything, so
// the downside of being wrong is the status quo.
describe("B1 — the repair contract mirrors the one that demonstrably works", () => {
  const prompt = () =>
    buildRepairPrompt({
      failureCode: "start_occluded",
      evidence: { rafCountAtSettle: 0, rafCountFinal: 0, canvas: null, pixel: null,
        start: { found: true, x: 10, y: 20, occluded: true, occluder: "div.overlay" } },
      errors: [],
      originalRequest: "a flying game",
      html: "<html><body>THE GAME SOURCE</body></html>",
    });

  it("R.1 puts the SOURCE first and the instruction LAST, so recency favours the ask", () => {
    const p = prompt();
    expect(p.indexOf("THE GAME SOURCE")).toBeLessThan(p.indexOf("div.overlay"));
    // And the very end of the prompt is the instruction, not raw markup.
    expect(p.trim().endsWith("</body></html>")).toBe(false);
  });

  it("R.2 still carries the full diagnosis and the child's original ask", () => {
    const p = prompt();
    expect(p).toContain("div.overlay");
    expect(p).toContain("a flying game");
    expect(p).toContain("THE GAME SOURCE");
  });

  it("R.3 the system prompt permits one short sentence before the blocks", () => {
    expect(REPAIR_SYSTEM_PROMPT).toMatch(/one short.*sentence/i);
  });

  it("R.4 the system prompt names the last-resort full-document fallback", () => {
    // applyPatch has always accepted this (mode: "regeneration"). Forbidding it
    // left a model that cannot patch with no valid output at all.
    expect(REPAIR_SYSTEM_PROMPT).toMatch(/last resort|only if/i);
    expect(REPAIR_SYSTEM_PROMPT).toMatch(/whole|full|complete/i);
  });

  it("R.5 a reply that opens with a sentence still applies cleanly", () => {
    // The behaviour that makes rule R.3 safe.
    const html = "<html><body><p>hello</p></body></html>";
    const reply = [
      "Good spot — that panel was sitting over the button!",
      "<<<<<<< SEARCH",
      "<p>hello</p>",
      "=======",
      "<p>fixed</p>",
      ">>>>>>> REPLACE",
    ].join("\n");
    const out = applyPatch(html, reply);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.mode).toBe("patch");
      expect(out.html).toContain("<p>fixed</p>");
    }
  });
});
