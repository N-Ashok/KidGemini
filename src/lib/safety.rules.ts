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

const BLOCK_WORDS = [
  "fuck", "shit", "bitch", "asshole", "bastard", "dick", "pussy",
  "sex", "porn", "nude", "naked", "rape",
  "suicide", "killmyself", "killyourself", "selfharm", "cutmyself",
];

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
    for (const w of BLOCK_WORDS) {
      if (norm.includes(w)) {
        return { action: "hard_block", category: HARD, severity: "high", reason: `Matched blocked term (rule).` };
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
