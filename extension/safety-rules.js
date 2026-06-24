// Deterministic local safety rules — runs in the content script, ₹0, instant, offline.
// Mirrors the app's Layer-0 design (PRD F2). Returns { action, category, reason }.
// This is the fast, always-on fallback; the LLM check (via the app's /api/safety) is
// layered on top when configured.

(function () {
  // Normalize leetspeak / spacing so "f.u.c.k" / "fu ck" don't slip through.
  function normalize(text) {
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

  // Keep this list small + maintainable; extend via the popup later if needed.
  var BLOCK_WORDS = [
    "fuck", "shit", "bitch", "asshole", "bastard", "dick", "pussy",
    "sex", "porn", "nude", "naked", "rape",
    "suicide", "killmyself", "killyourself", "selfharm", "cutmyself",
  ];

  // PII the CHILD might share (used when checking user input).
  var PII_PATTERNS = [
    { re: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, label: "phone number" },
    { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, label: "email" },
    { re: /\b\d{1,5}\s+[A-Za-z]{2,}\s+(street|st|road|rd|avenue|ave|lane|ln)\b/i, label: "address" },
  ];

  function classifyLocal(text, origin) {
    var norm = normalize(text);
    for (var i = 0; i < BLOCK_WORDS.length; i++) {
      if (norm.indexOf(BLOCK_WORDS[i]) !== -1) {
        return {
          action: "hard_block",
          category: "profanity_or_adult",
          reason: "Matched blocked term (local rule).",
        };
      }
    }
    if (origin === "child") {
      for (var j = 0; j < PII_PATTERNS.length; j++) {
        if (PII_PATTERNS[j].re.test(text)) {
          return {
            action: "soft_block",
            category: "personal_info",
            reason: "Looks like a " + PII_PATTERNS[j].label + " (local rule).",
          };
        }
      }
    }
    return { action: "allow", category: null, reason: "No local rule matched." };
  }

  // Expose to content.js (same isolated world).
  window.KidGeminiRules = { classifyLocal: classifyLocal };
})();
