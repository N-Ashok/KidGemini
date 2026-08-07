// Deterministic three-import lint (BUG-FIX-LOG 2026-07-20 "DoubleSide").
// The vendored engine bundle exports a CURATED list; a generated game that
// imports any other name dies on its import line — the entire game script
// never runs, which no amount of self-healing can patch away. This lint
// finds those violations server-side so /api/chat can retry or reject
// BEFORE a dead game reaches a kid. Pure string logic, no I/O.

import { CURATED_IMPORT_NAMES } from "./prompt-catalog";

/** The loader helper Ari itself injects imports these from "three" too —
 *  vendored via separate entry lines in scripts/vendor-three.mjs. */
const LOADER_IMPORTS = ["GLTFLoader", "MeshoptDecoder"];

const ALLOWED = new Set([...CURATED_IMPORT_NAMES, ...LOADER_IMPORTS]);

/** Matches every named-import statement targeting "three". Namespace imports
 *  (`import * as THREE`) are ignored — they cannot crash the import line. */
const NAMED_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*(['"])three\2/g;

/** All names imported from "three" that the vendored bundle does NOT export
 *  (original names, not aliases), deduped, in order of appearance. */
export function unknownThreeImports(html: string): string[] {
  const unknown: string[] = [];
  for (const m of html.matchAll(NAMED_IMPORT_RE)) {
    for (const raw of m[1]!.split(",")) {
      const original = raw.trim().split(/\s+as\s+/)[0]!.trim();
      if (!original) continue;
      if (!ALLOWED.has(original) && !unknown.includes(original)) unknown.push(original);
    }
  }
  return unknown;
}

/** Violations a patched version INTRODUCED relative to its source — an edit
 *  patch is judged only on what it added, so a pre-existing (old-bundle)
 *  violation can't fail every unrelated future patch. */
export function newUnknownThreeImports(beforeHtml: string, afterHtml: string): string[] {
  const before = new Set(unknownThreeImports(beforeHtml));
  return unknownThreeImports(afterHtml).filter((n) => !before.has(n));
}

// ── The MIRROR defect: used but not imported ─────────────────────────────────
// BUG-FIX-LOG 2026-08-07 (PointLight addendum): a delivered game called
// `new PointLight(...)` with PointLight missing from its import list —
// ReferenceError at play time (the import line itself is fine, so the game
// LOADS and the verify pass sees "clean"; it dies only when the code path
// finally runs). Deterministic heal, no model turn: append the missing name
// to the game's own first `import { ... } from "three"` list.
//
// Guard rails: only names in ALLOWED are ever added (adding an unvendored
// name would create the import-line crash the lint above exists to catch);
// bare `new Name(` usage only (a `THREE.Name` or game-declared Name needs no
// binding); games with no `from "three"` import at all (2D, or legacy unpkg
// URLs) pass through byte-identical.

/** MathUtils is the one curated export games use statically (MathUtils.clamp)
 *  rather than construct — everything else in ALLOWED is `new`-ed. DoubleSide
 *  (a bare constant) is deliberately out: `DoubleSide` alone is too weak a
 *  signal vs. a game's own variable, and its absence fails soft (material
 *  renders single-sided) rather than throwing. */
const STATIC_USE_RE = /\bMathUtils\s*\./;

const LOCAL_DECL_RE = (name: string) =>
  new RegExp(`\\b(?:class|function|const|let|var)\\s+${name}\\b`);

export function ensureThreeImports(html: string): string {
  const imports = [...html.matchAll(NAMED_IMPORT_RE)];
  if (imports.length === 0) return html;

  // Every LOCAL binding the game already has from "three" (aliases count by
  // their local name — that's the identifier the code actually uses).
  const bound = new Set<string>();
  for (const m of imports) {
    for (const raw of m[1]!.split(",")) {
      const local = raw.trim().split(/\s+as\s+/).pop()!.trim();
      if (local) bound.add(local);
    }
  }

  const missing: string[] = [];
  for (const name of ALLOWED) {
    if (bound.has(name) || missing.includes(name)) continue;
    const used =
      name === "MathUtils"
        ? STATIC_USE_RE.test(html)
        : new RegExp(`(?<![.\\w])new\\s+${name}\\s*\\(`).test(html);
    if (!used) continue;
    if (LOCAL_DECL_RE(name).test(html)) continue; // the game made its own
    missing.push(name);
  }
  if (missing.length === 0) return html;

  // Heal the FIRST three-import: insert before its closing brace, preserving
  // the game's own formatting around it.
  const first = imports[0]!;
  const inner = first[1]!;
  const trimmedEnd = inner.replace(/\s+$/, "");
  const tail = inner.slice(trimmedEnd.length);
  const healedInner = `${trimmedEnd}, ${missing.join(", ")}${tail || " "}`;
  const healedStatement = first[0]!.replace(inner, healedInner);
  return html.replace(first[0]!, healedStatement);
}
