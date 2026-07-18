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

// Self-harm terms — deliberately matched against the FULLY space-stripped
// message, since a genuine expression is naturally written across real word
// boundaries ("kill myself", "cut myself") and needs the merge to be caught.
const SELF_HARM = ["suicide", "killmyself", "killyourself", "selfharm", "cutmyself"];

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
    const norm = normalize(input.text);
    for (const w of SELF_HARM) {
      if (norm.includes(w)) {
        return { action: "hard_block", category: HARD, severity: "high", reason: `Matched blocked term (rule).` };
      }
    }
    for (const word of collapseSpelledOutLetters(input.text)) {
      for (const w of PROFANITY) {
        if (word.includes(w)) {
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
