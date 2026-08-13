// Deterministic pre-delivery syntax check (owner ask 2026-08-13, after a real
// generated game — River Nomad 3D — crashed on load with `pageerror: Invalid
// or unexpected token`, confirmed by loading the stored artifact in a real
// browser). A parse with acorn costs single-digit milliseconds and needs no
// browser, no headless Chromium, no extra model call — the cheapest possible
// check in the whole pipeline, run BEFORE a document ever reaches a kid.
//
// Scope, deliberately narrow: this catches SYNTAX errors only — malformed JS
// that fails to PARSE. It cannot see a hallucinated API call (valid syntax,
// wrong method name, e.g. the separate `MathUtils.makeQuaternionFromEuler is
// not a function` bug from the same game's edit history) — that class needs
// actual execution, which is what the browser-based self-heal probe already
// covers after the fact. The two are complementary, not redundant.

import { parse } from "acorn";

export interface JsSyntaxError {
  message: string;
  line: number | undefined;
}

/** Matches every inline `<script>` tag with its `type` attribute (if any)
 *  captured separately — `(?![^>]*\bsrc=)` skips external-script tags
 *  entirely (nothing to parse; already caught by externalScriptSrcs in
 *  three-import-lint.ts). Every game carries a leading `<script
 *  type="importmap">` (JSON, not JS) — matching it regardless of type and
 *  feeding its body to a JS parser is a real false positive, caught in
 *  testing before this shipped: it would have flagged VALID JSON as a syntax
 *  error on every 3D game. */
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)(?:[^>]*\btype=["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/script>/gi;

/** `type` values that are genuinely JavaScript. Absent `type` defaults to JS
 *  per the HTML spec, which is why it's included here rather than treated as
 *  "unknown → skip". */
const JS_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);

/** Parses every inline script with acorn and returns the FIRST syntax error
 *  found, or null if every block parses cleanly. `sourceType: "module"` so
 *  the bare `import { ... } from "three"` this platform's games always carry
 *  parses correctly instead of being flagged as invalid top-level syntax. */
export function findJsSyntaxError(html: string): JsSyntaxError | null {
  for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
    const type = (match[1] ?? "").trim().toLowerCase();
    if (!JS_SCRIPT_TYPES.has(type)) continue;
    const code = match[2] ?? "";
    if (!code.trim()) continue;
    try {
      parse(code, { ecmaVersion: "latest", sourceType: "module" });
    } catch (err) {
      const e = err as { message?: string; loc?: { line?: number } };
      return { message: e.message ?? "syntax error", line: e.loc?.line };
    }
  }
  return null;
}
