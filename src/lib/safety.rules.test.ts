import { describe, it, expect } from "vitest";
import { RulesClassifier } from "./safety.rules";

const rules = new RulesClassifier();
const child = (text: string) => rules.classifySync({ text, origin: "child" as const });

/** Production bug (2026-07-18): normalize() strips ALL whitespace before
 *  substring-matching BLOCK_WORDS, so two innocent whitespace-separated
 *  words can merge into a blocked one at their boundary — "medic kit" ->
 *  "medickit" contains "dick". Kept the space-stripping (needed to catch
 *  "f u c k" and the concatenated self-harm phrases below) but scoped the
 *  short profanity list to per-word matching instead of the whole string. */
describe("RulesClassifier — word-boundary false positives (BUG-FIX-LOG 2026-07-18)", () => {
  it("does not hard-block 'medic kit' — two real words colliding into 'dick' at the boundary", () => {
    const v = child("enemy can pick medic kit and increase his life");
    expect(v.action).toBe("allow");
  });

  it("a standalone blocked word is still caught even next to an innocent neighbor (not the boundary bug)", () => {
    expect(child("the class is titled sex ed").action).toBe("hard_block"); // "sex" is itself a real standalone blocked word
  });

  it("still hard-blocks letter-spaced evasion of a single word ('f u c k')", () => {
    expect(child("f u c k you").action).toBe("hard_block");
  });

  it("still hard-blocks punctuation-obfuscated profanity within one token ('d.i.c.k')", () => {
    expect(child("you are a d.i.c.k").action).toBe("hard_block");
  });

  it("still hard-blocks leetspeak within one token ('sh1t')", () => {
    expect(child("this is sh1t").action).toBe("hard_block");
  });

  it("still hard-blocks a plain single-word profanity match", () => {
    expect(child("you are an asshole").action).toBe("hard_block");
  });

  it("still hard-blocks self-harm phrases written across real word boundaries", () => {
    expect(child("i want to kill myself").action).toBe("hard_block");
    expect(child("i keep wanting to cut myself").action).toBe("hard_block");
  });

  it("allow is still the default for genuinely unremarkable text", () => {
    expect(child("can you add a jump button to my platformer game").action).toBe("allow");
  });
});

/** Production bug (2026-07-31, docs/BUG-FIX-LOG.md): "rape" is 4 letters
 *  short enough to appear INSIDE several ordinary English words as a real
 *  substring — not two words colliding at a boundary (the 2026-07-18 bug
 *  above), but one single genuine word containing the banned substring
 *  (the classic "Scunthorpe problem"). A kid asking for 3D skyscrapers got
 *  hard-blocked and parent-alerted for a completely benign build request. */
describe("RulesClassifier — single-word false positives on 'rape' (BUG-FIX-LOG 2026-07-31)", () => {
  it("does not hard-block 'skyscrapers' — a real word that happens to contain 'rape'", () => {
    expect(child("can you add 3D skyscrapers and 3D houses and 3D flats").action).toBe("allow");
  });

  it("does not hard-block other ordinary words containing 'rape'", () => {
    expect(child("can you add a grape to the fruit basket").action).toBe("allow");
    expect(child("put drapes on the window").action).toBe("allow");
    expect(child("i want grapefruit juice in the game").action).toBe("allow");
  });

  it("still hard-blocks the actual word 'rape' on its own", () => {
    expect(child("rape").action).toBe("hard_block");
  });

  it("still hard-blocks 'rape' as a standalone word next to other words", () => {
    expect(child("i want to make a game about rape").action).toBe("hard_block");
  });
});

/** Full audit (2026-07-31, docs/BUG-FIX-LOG.md): the "skyscrapers" bug above
 *  was one instance of a general class, not a one-off. Scanned the full
 *  macOS dictionary (/usr/share/dict/words, 236K entries) against every term
 *  in PROFANITY for real-word substring collisions, then allowlisted the
 *  ones a kid could plausibly type on this product — including a
 *  product-specific one: `shittim`/`shittah` are real biblical wood terms
 *  (Exodus, the Ark of the Covenant), and this app has a Bible-teacher
 *  persona (PRD-BIBLE-TEACHER.md), so that collision is a live risk, not
 *  theoretical. */
describe("RulesClassifier — full PROFANITY-list collision audit (BUG-FIX-LOG 2026-07-31)", () => {
  it("does not hard-block more 'rape' collisions common in a game/education context", () => {
    expect(child("can you make a game about a scraper robot").action).toBe("allow");
    expect(child("the scrape happened when he fell down").action).toBe("allow");
    expect(child("she went to see a therapist").action).toBe("allow");
    expect(child("physical therapy helped him walk again").action).toBe("allow");
    expect(child("this is a therapeutic game for kids").action).toBe("allow");
  });

  it("does not hard-block biblical wood terms ('shittim'/'shittah') — Bible-teacher persona", () => {
    expect(child("what is shittim wood used for in the bible").action).toBe("allow");
    expect(child("tell me about the shittah tree").action).toBe("allow");
  });

  it("does not hard-block common 'sex' collisions (place names, a pirate's tool)", () => {
    expect(child("a pirate uses a sextant to navigate").action).toBe("allow");
    expect(child("essex is a county in england").action).toBe("allow");
    expect(child("play a sextet of instruments").action).toBe("allow");
  });

  it("does not hard-block 'dickens' (Charles Dickens, common in story content)", () => {
    expect(child("can we make a game based on charles dickens").action).toBe("allow");
  });

  it("does not hard-block 'pussycat' (nursery-rhyme term)", () => {
    expect(child("add a pussycat character to my game").action).toBe("allow");
  });

  it("still hard-blocks the bare profane words themselves, unaffected by the audit", () => {
    expect(child("sex").action).toBe("hard_block");
    expect(child("dick").action).toBe("hard_block");
    expect(child("shit").action).toBe("hard_block");
    expect(child("pussy").action).toBe("hard_block");
  });
});

/** Production bug (2026-08-05, docs/BUG-FIX-LOG.md): the app's OWN error
 *  report (error-report.ts, built for pasting into this chat) got soft-blocked
 *  as "email" PII and answered with the KIND_REDIRECT deflection — because the
 *  email regex matched the npm version specifier inside a CDN URL
 *  ("https://cdn.jsdelivr.net/npm/three@0.158.0/..."). A real email address
 *  always ends in an alphabetic TLD; a version specifier never does. */
describe("RulesClassifier — email-PII false positive on npm version specifiers (BUG-FIX-LOG 2026-08-05)", () => {
  it("does not soft-block a pasted game error report carrying a versioned CDN URL", () => {
    const report = [
      "Ari — game error report",
      "Game: Rainbow Dog Sled Adventure",
      "When: 2026-08-05T09:53:18.694Z",
      "Check result: failed (verify_failed)",
      "3. Uncaught SyntaxError: The requested module 'three' does not provide an export named 'BufferAttribute' (https://cdn.jsdelivr.net/npm/three@0.158.0/examples/jsm/utils/BufferGeometryUtils.js:2:2)",
      "Browser: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    ].join("\n");
    expect(child(report).action).toBe("allow");
  });

  it("does not soft-block a bare scoped-package specifier ('three@0.158.0')", () => {
    expect(child("my game loads three@0.158.0 from a cdn").action).toBe("allow");
  });

  it("still soft-blocks a genuine email address", () => {
    const v = child("my email is kid123@gmail.com");
    expect(v.action).toBe("soft_block");
    expect(v.category).toBe("personal_info");
  });

  it("still soft-blocks a genuine email with digits in the domain", () => {
    expect(child("write to me at someone@mail2.example.org").action).toBe("soft_block");
  });
});

/** Production bug (KNOWN_BUGS #7 / #12, 2026-07-27): an oversized message
 *  (~100K chars of game source accidentally folded into a chat turn, see
 *  BUG-FIX-LOG same date) raised the odds of an accidental SELF_HARM
 *  whole-string substring hit. MAX_SCAN_CHARS bounds that unbounded scan —
 *  PROFANITY is already per-token and structurally safer, so only the
 *  whole-string SELF_HARM check needs a ceiling. */
describe("RulesClassifier — MAX_SCAN_CHARS backstop (KNOWN_BUGS #7/#12)", () => {
  it("still catches a self-harm phrase well within the ceiling", () => {
    const v = child("i want to kill myself " + "x".repeat(500));
    expect(v.action).toBe("hard_block");
  });

  it("catches a self-harm phrase placed inside the first 4000 chars of a huge message", () => {
    const padded = "a".repeat(1000) + "i want to kill myself" + "b".repeat(50_000);
    expect(child(padded).action).toBe("hard_block");
  });

  it("does NOT hard-block on a self-harm phrase that only appears well beyond the ceiling", () => {
    const padded = "a".repeat(10_000) + "i want to kill myself" + "b".repeat(90_000);
    expect(child(padded).action).toBe("allow");
  });

  it("does not false-positive on a huge benign payload (e.g. re-attached game source)", () => {
    const gameLikeSource = "<html><head></head><body>".repeat(4000);
    expect(child(gameLikeSource).action).toBe("allow");
  });

  it("still catches ordinary short profanity/self-harm messages unaffected by the ceiling", () => {
    expect(child("you are an asshole").action).toBe("hard_block");
    expect(child("i keep wanting to cut myself").action).toBe("hard_block");
  });
});
