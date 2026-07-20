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
