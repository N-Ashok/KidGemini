// Deterministic three-import lint (BUG-FIX-LOG 2026-07-20 "DoubleSide").
// The vendored engine bundle exports a CURATED list; a generated game that
// imports any other name dies on its import line — the entire game script
// never runs, which no amount of self-healing can patch away. This lint
// finds those violations server-side so /api/chat can retry or reject
// BEFORE a dead game reaches a kid. Pure string logic, no I/O.

import { ASSET_HOST_ORIGIN } from "./manifest";
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

// ── The BYPASS defect: the game never joins the pipeline at all ──────────────
// BUG_LOG 2026-08-09 (Calvin). The lint above only sees games that ALREADY
// speak the vendored contract — it matches `import {...} from "three"`. A game
// that skips the contract entirely is invisible to it, and that is exactly
// what shipped: no `<!--USES_THREE-->` marker, no import map, no ES import,
// just `<script src="https://cdnjs.cloudflare.com/.../r128/three.min.js">`
// and global `THREE.*` calls. r128 predates CapsuleGeometry, so the game threw
// "THREE.CapsuleGeometry is not a constructor" on the line building the
// child's own character and rendered nothing.
//
// Why this is a lint and not a heal: rewriting global-namespace `THREE.*` code
// into the ESM contract is not a safe string transform (owner decision,
// 2026-08-09) — we'd trade one broken game for a differently broken one. One
// corrective retry naming the violation is the same shape the import lint
// already uses, and it fails soft: if the retry isn't clean, the original is
// still served (visible + repairable beats dropped).
//
// Scope is ANY off-origin script, not just three (owner decision, 2026-08-09):
// the defect is the bypass, not the library. A generated game must be
// self-contained apart from the asset host — a third-party CDN in a PUBLISHED
// game is a liveness dependency on someone else's uptime.

/** Matches `<script ... src=URL ...>` — any attribute order, quoted with
 *  either quote or UNQUOTED. The unquoted alternative is not pedantry: it is
 *  valid HTML the browser loads identically, and without it this lint was
 *  fail-open on exactly the shape it exists to catch (review regression). */
const SCRIPT_SRC_RE = /<script\b[^>]*?\bsrc\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))[^>]*>/gi;

/** The one origin a generated game is allowed to load from: our immutable
 *  asset host (`ASSET_HOST_ORIGIN` — the vendored engine and models). Imported
 *  rather than re-typed: it was duplicated here as a literal "to stay pure",
 *  but manifest.ts exports it as a plain const with no I/O, so the copy bought
 *  nothing and risked drift. */
const ALLOWED_SCRIPT_HOST = ASSET_HOST_ORIGIN.replace(/^https?:/, "");

/** True for a URL served by our asset host — matched on the ORIGIN with a
 *  boundary, so `assets.ariantra.com.cdn-mirror.example` is not mistaken for
 *  `assets.ariantra.com` (review regression), and protocol-relative
 *  `//assets.ariantra.com/...` is correctly recognised as ours. */
function isAssetHost(url: string): boolean {
  const bare = url.replace(/^https?:/, "");
  return bare === ALLOWED_SCRIPT_HOST || bare.startsWith(`${ALLOWED_SCRIPT_HOST}/`);
}

/** Every off-origin `<script src>` URL in the document, deduped, in order of
 *  appearance. Relative srcs (`/sdk.js`) and inline scripts are fine — only an
 *  absolute or protocol-relative URL to a foreign origin is a bypass. */
export function externalScriptSrcs(html: string): string[] {
  const found: string[] = [];
  for (const m of html.matchAll(SCRIPT_SRC_RE)) {
    const src = (m[2] ?? m[3] ?? "").trim();
    if (!src) continue;
    const isAbsolute = /^(https?:)?\/\//i.test(src);
    if (!isAbsolute) continue; // relative/same-document — not a bypass
    if (isAssetHost(src)) continue;
    if (!found.includes(src)) found.push(src);
  }
  return found;
}

/** Bypasses a patched version INTRODUCED relative to its source. Mirrors
 *  newUnknownThreeImports: a game that ALREADY loads a CDN (there are stored
 *  ones) must stay editable, or every future patch on it would fail for a
 *  violation the child didn't just make. */
export function newExternalScriptSrcs(beforeHtml: string, afterHtml: string): string[] {
  const before = new Set(externalScriptSrcs(beforeHtml));
  return externalScriptSrcs(afterHtml).filter((s) => !before.has(s));
}

// ── The bypass's RELATIVE form: an invented local file layout ────────────────
// BUG_LOG 2026-08-09, found by running all 312 stored conversations through the
// browser harness while measuring Calvin's blast radius. A stored car-racing
// game imported `./three.module.js`, `./jsm/loaders/GLTFLoader.js` and
// `./main.js` — a multi-file three.js checkout that has never existed for a
// single-document game — and died on `Failed to resolve module specifier`.
//
// Neither lint above sees it: a relative src is not an external script, and
// NAMED_IMPORT_RE only inspects `from "three"`. A generated game is ONE
// self-contained document, so the only legal module specifier is the bare
// `three` the import map resolves (plus the asset host, belt and braces).
// Everything else is a file that will never exist at play time.

/** Every ES-module import specifier in the document: `import … from "X"`,
 *  bare side-effect `import "X"`, and dynamic `import("X")`. */
const MODULE_SPECIFIER_RE =
  /\bimport\s*(?:\(\s*(['"])(.*?)\1\s*\)|(?:[^'"()]*?\bfrom\s*)?(['"])(.*?)\3)/g;

/** The bare specifiers the injected import map actually resolves. BOTH are
 *  real: `inject.ts` writes `imports["three"]` and, for a physics game,
 *  `imports["cannon-es"]` — and `physics-playbook.ts` teaches
 *  `import { World, Body, … } from "cannon-es"` on every gates.three turn.
 *
 *  This list shipped as just `["three"]` for one deploy, which made EVERY 3D
 *  physics game trip a full corrective regeneration (~50s + the child's
 *  Sparks) — and since the corrective prompt named `three` as the only legal
 *  specifier, a "clean" retry was one that had dropped the physics engine.
 *  Pinned by a lockstep test: whatever the playbook teaches must be allowed
 *  here. If a third engine is ever added to the import map, add it here in the
 *  same change. */
const ALLOWED_BARE_SPECIFIERS = new Set(["three", "cannon-es"]);

/** Import specifiers that cannot resolve in a single-document game, deduped,
 *  in order of appearance. The import map's bare specifiers are the contract;
 *  the asset host is the only other legal origin. */
export function danglingModuleSpecifiers(html: string): string[] {
  const bad: string[] = [];
  for (const m of html.matchAll(MODULE_SPECIFIER_RE)) {
    const spec = (m[2] ?? m[4] ?? "").trim();
    if (!spec) continue;
    if (ALLOWED_BARE_SPECIFIERS.has(spec)) continue; // resolved by the import map
    if (isAssetHost(spec)) continue;
    if (!bad.includes(spec)) bad.push(spec);
  }
  return bad;
}

/** Patch gate — judged only on what the patch ADDED, same reasoning as
 *  newExternalScriptSrcs: a stored game already carrying one of these must
 *  stay editable rather than failing every future edit. */
export function newDanglingModuleSpecifiers(beforeHtml: string, afterHtml: string): string[] {
  const before = new Set(danglingModuleSpecifiers(beforeHtml));
  return danglingModuleSpecifiers(afterHtml).filter((s) => !before.has(s));
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

// ── The CATEGORY defect: a runtime global imported from "three" ─────────────
// BUG-FIX-LOG 2026-08-08. Prod log: `unknown three imports: loadModel,
// loadModelBatch — corrective retry`. These are helpers ARI injects as window
// globals (inject.ts's loadModelHelper/loadModelBatchHelper/audioHelper), and
// prompt-catalog.ts tells the model to call them as built-ins — so importing
// them from "three" is a category error, not a missing export. It killed the
// import line (whole game dead) and cost a full corrective LLM round-trip
// (~50s + the kid's Sparks) to re-generate.
//
// Deterministic heal, no model turn: drop those names from the import list.
// Safe by construction — the identifiers still resolve at run time from
// window, so the game's own calls are left completely untouched.

/** Globals the asset runtime defines on `window` (grep: `window.X =` in
 *  lib/assets). requestAnimationFrame is deliberately absent — it's a browser
 *  builtin the runtime merely wraps, never something a game would import.
 *
 *  ONLY list helpers that actually exist. Stripping a name that is NOT a real
 *  global trades a loud failure for a quiet one: the dead import line (game
 *  never runs, verify catches it) becomes a play-time ReferenceError that
 *  verify reports as "clean" — precisely the PointLight class from
 *  BUG-FIX-LOG 2026-08-07. `modelSize` joined on 2026-08-08 only once the
 *  model-sizing work actually shipped its `window.modelSize` helper — verify
 *  the helper exists before adding a name here. */
const RUNTIME_GLOBALS = new Set(["loadModel", "loadModelBatch", "modelSize", "playSound", "playMusic"]);

export function stripRuntimeGlobalImports(html: string): string {
  let out = html;
  for (const stmt of [...html.matchAll(NAMED_IMPORT_RE)]) {
    const inner = stmt[1]!;
    const kept: string[] = [];
    let stripped = false;
    for (const raw of inner.split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      // Match on the ORIGINAL name — `loadModel as lm` is still the global.
      const original = spec.split(/\s+as\s+/)[0]!.trim();
      if (RUNTIME_GLOBALS.has(original)) stripped = true;
      else kept.push(spec);
    }
    if (!stripped) continue;
    // Nothing real left to import: drop the statement entirely rather than
    // leave an empty `import {} from "three"`. Safe — every name it carried
    // was a global, and as written the statement was crashing anyway.
    out = out.replace(stmt[0]!, kept.length === 0 ? "" : `import { ${kept.join(", ")} } from "three"`);
  }
  return out;
}

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
