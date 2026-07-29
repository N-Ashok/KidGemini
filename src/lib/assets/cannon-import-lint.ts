// Deterministic cannon-es import lint (2026-07-29, docs/2026-07-29_PRD_Physics.md).
// Exact sibling of three-import-lint.ts, and it exists for the same reason:
// the vendored physics bundle exports a CURATED list, and a generated game that
// imports any other name dies on its import line — the whole game script never
// runs, which no amount of self-healing can patch away. Pure string logic, no I/O.

/** Names the vendored cannon bundle actually exports — MUST stay in lockstep
 *  with CANNON_EXPORTS in scripts/vendor-cannon.mjs (pinned by test) and with
 *  the names the physics prompt clause teaches. */
export const CANNON_IMPORT_NAMES = [
  "World", "Body", "Vec3", "Quaternion",
  "Box", "Sphere", "Plane", "Cylinder",
  "Material", "ContactMaterial",
] as const;

const ALLOWED = new Set<string>(CANNON_IMPORT_NAMES);

/** Matches every named-import statement targeting "cannon-es". Namespace
 *  imports (`import * as CANNON`) are ignored — they cannot crash the import
 *  line (same carve-out as the three lint). */
const NAMED_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*(['"])cannon-es\2/g;

/** All names imported from "cannon-es" that the vendored bundle does NOT
 *  export (original names, not aliases), deduped, in order of appearance. */
export function unknownCannonImports(html: string): string[] {
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
 *  patch is judged only on what it added, so a pre-existing violation can't
 *  fail every unrelated future patch. */
export function newUnknownCannonImports(beforeHtml: string, afterHtml: string): string[] {
  const before = new Set(unknownCannonImports(beforeHtml));
  return unknownCannonImports(afterHtml).filter((n) => !before.has(n));
}
