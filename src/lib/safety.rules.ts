// Layer-0 deterministic safety (PRD F2): instant, ₹0, offline, 100% reproducible.
// Used as the fast input pre-check so obviously-safe prompts skip the ~2s LLM call.
// Implements SafetyClassifier (Liskov) so it slots in anywhere the LLM one does.

import type {
  SafetyCategory,
  SafetyClassifier,
  SafetyVerdict,
} from "@/types/safety.types";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s._\-*]+/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/@/g, "a");
}

// Same substitutions as normalize(), applied to one already-whitespace-split
// token — no \s in the punctuation class since a token has none.
function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[._\-*]+/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/@/g, "a");
}

/** Real evasion technique: spelling a word out with a separator between EVERY
 *  letter ("f u c k", "d.i.c.k"). Merges consecutive single-character tokens
 *  together before matching, but leaves genuine short words (2+ letters —
 *  "to", "an", "kit") untouched, so "medic kit" doesn't get glued into
 *  "medickit" (see PROFANITY below) while "f u c k" still gets caught. */
function collapseSpelledOutLetters(text: string): string[] {
  const merged: string[] = [];
  let buffer = "";
  for (const raw of text.split(/\s+/)) {
    const cleaned = normalizeToken(raw);
    if (cleaned.length === 1) {
      buffer += cleaned;
      continue;
    }
    if (buffer) {
      merged.push(buffer);
      buffer = "";
    }
    if (cleaned) merged.push(cleaned);
  }
  if (buffer) merged.push(buffer);
  return merged;
}

// Short profanity/sexual terms — matched PER WORD TOKEN (see
// collapseSpelledOutLetters), never against the whole message concatenated,
// because concatenating two unrelated real words can accidentally spell one
// of these at the boundary (BUG-FIX-LOG 2026-07-18: "medic kit" -> "medickit"
// contains "dick").
const PROFANITY = [
  "fuck", "shit", "bitch", "asshole", "bastard", "dick", "pussy",
  "sex", "porn", "nude", "naked", "rape",
];

// The Scunthorpe problem (BUG-FIX-LOG 2026-07-31): several PROFANITY terms
// are short enough to occur as a genuine substring of ordinary English
// words, not just at a cross-token boundary (the 2026-07-18 "medic kit" bug
// above) — a single real word can contain one outright. "3D skyscrapers"
// hard-blocked and parent-alerted a completely benign build request.
// Audited every term against the full macOS dictionary
// (/usr/share/dict/words, 236K entries) for real collisions, then kept the
// ones a kid could plausibly type on this product — including
// `shittim`/`shittah` (real biblical wood terms, Exodus — this app has a
// Bible-teacher persona, so that's a live risk, not theoretical). Listed per
// profane term so a real hit on the bare word, or an actual derived form
// (e.g. "raped"/"rapist"), still blocks — only these specific known-safe
// whole words are exempted, not the substring generally.
const PROFANITY_SAFE_WORDS: Record<string, string[]> = {
  rape: [
    "grape", "grapes", "grapefruit",
    "drape", "drapes", "draped", "draping", "draper", "drapery",
    "skyscraper", "skyscrapers",
    "scrape", "scraped", "scraper", "scrapers", "scraping",
    "therapy", "therapist", "therapists", "therapeutic", "therapeutics",
  ],
  shit: ["shittim", "shittah"],
  sex: [
    "sextant", "sextants", "sextet", "sextets", "sexton", "sextons",
    "unisex", "essex", "sussex", "wessex", "middlesex",
  ],
  dick: ["dickens", "dickey", "dickeys"],
  pussy: ["pussycat", "pussycats"],
};

// Self-harm terms — deliberately matched against the FULLY space-stripped
// message, since a genuine expression is naturally written across real word
// boundaries ("kill myself", "cut myself") and needs the merge to be caught.
const SELF_HARM = ["suicide", "killmyself", "killyourself", "selfharm", "cutmyself"];

// Defense-in-depth ceiling (KNOWN_BUGS #7/#12, 2026-07-27): SELF_HARM is the
// only unbounded whole-string check here (PROFANITY is per-token, already
// safe at any length). A genuine child message is never anywhere near this
// long; bounding it means an oversized payload that reaches this classifier
// by accident degrades to "scan the first 4K chars" instead of a guaranteed
// false-positive surface across the whole thing.
const MAX_SELF_HARM_SCAN_CHARS = 4000;

const PII: Array<{ re: RegExp; label: string }> = [
  { re: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, label: "phone number" },
  { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, label: "email" },
  { re: /\b\d{1,5}\s+[A-Za-z]{2,}\s+(street|st|road|rd|avenue|ave|lane|ln)\b/i, label: "address" },
];

const HARD: SafetyCategory = "profanity";

/**
 * Deterministic verdict. Returns "allow" when no rule matches — but "allow" here means
 * "no DETERMINISTIC concern found", not "definitely safe". Callers that need the nuanced
 * gray-zone judgment should still consult the LLM classifier (see CompositeClassifier idea
 * in CLAUDE.md). For the input fast-path we treat a clean result as safe-enough to proceed,
 * with the LLM check running in the background for alerting.
 */
export class RulesClassifier implements SafetyClassifier {
  async classify(input: { text: string; origin: "child" | "model" }): Promise<SafetyVerdict> {
    return this.classifySync(input);
  }

  classifySync(input: { text: string; origin: "child" | "model" }): SafetyVerdict {
    const norm = normalize(input.text.slice(0, MAX_SELF_HARM_SCAN_CHARS));
    for (const w of SELF_HARM) {
      if (norm.includes(w)) {
        return { action: "hard_block", category: HARD, severity: "high", reason: `Matched blocked term (rule).` };
      }
    }
    for (const word of collapseSpelledOutLetters(input.text)) {
      for (const w of PROFANITY) {
        if (word.includes(w) && !PROFANITY_SAFE_WORDS[w]?.includes(word)) {
          return { action: "hard_block", category: HARD, severity: "high", reason: `Matched blocked term (rule).` };
        }
      }
    }
    if (input.origin === "child") {
      for (const p of PII) {
        if (p.re.test(input.text)) {
          return { action: "soft_block", category: "personal_info", severity: "medium", reason: `Looks like a ${p.label} (rule).` };
        }
      }
    }
    return { action: "allow", category: null, severity: "low", reason: "No deterministic rule matched." };
  }
}
