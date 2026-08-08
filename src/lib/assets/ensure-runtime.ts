// The marker-INDEPENDENT asset-runtime floor. inject.ts (server-only) resolves
// the model's `<!--USES_THREE-->` / `<!--USES_MODELS-->` markers at chat delivery
// — but that fires only when the marker is present and only on that one path.
// Any HTML that reaches the preview/verify/repair render with a bare
// `import ... from "three"` and NO import map crashes the iframe with
// `Failed to resolve module specifier "three"` (BUG-FIX-LOG 2026-07-23).
//
// This module is PURE (no server-only): it runs on the server (repair, delivery
// belt-and-suspenders) AND in the client preview, so no path can ever produce an
// unresolvable 3D game. It keys off what the game ACTUALLY uses (imports three /
// calls loadModel), not the marker, and is idempotent on already-injected HTML.

import manifestJson from "./manifest.json";
import type { AssetManifest } from "./manifest";
import { THREE_MARKER, PHYSICS_MARKER } from "./markers";
import {
  insertEarly,
  loadModelHelper,
  loadModelBatchHelper,
  frameGovernor,
  LOAD_MODEL_HELPER_VERSION,
  parseAssetTables,
  stripAssetTables,
  countAssetTables,
  parseSizeTables,
  stripSizeTables,
  countSizeTables,
  countAxisTables,
  parseAxisTables,
  stripAxisTables,
} from "./runtime-helpers";
import { injectPerfProbe } from "./perf-probe";

const IMPORTS_THREE_RE = /\bfrom\s*["']three["']/;
// Physics games import the second engine by its own bare specifier; an
// unmapped one dies on the import line exactly like an unmapped "three".
const IMPORTS_CANNON_RE = /\bfrom\s*["']cannon-es["']/;
const CALLS_LOADMODEL_RE = /\bloadModel\s*\(/;
const CALLS_LOADMODELBATCH_RE = /\bloadModelBatch\s*\(/;
const LOADMODEL_ARG_RE = /\bloadModel\s*\(\s*["']([a-z0-9_]+)["']/gi;
const ANY_IMPORTMAP_RE = /<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;
const HAS_HELPER_RE = /window\.loadModel\s*=/;
const HAS_LOADMODELBATCH_HELPER_RE = /window\.loadModelBatch\s*=/;
// A stale helper (published before the 2026-08-05 template-cache change, or
// any earlier version) still matches HAS_HELPER_RE but carries no version
// stamp, or an OLDER one — this is what lets an already-published game pick
// up a behavior change to loadModelHelper() the next time it's previewed,
// rather than being stuck forever on whatever shipped at publish time.
const HELPER_VERSION_RE = /window\.__arLoadModelVersion\s*=\s*(\d+)/;
function hasCurrentHelper(html: string): boolean {
  const m = html.match(HELPER_VERSION_RE);
  return !!m && Number(m[1]) >= LOAD_MODEL_HELPER_VERSION;
}
// Every individual <script>...</script> block, non-greedy so each match stays
// within ONE tag — used to find-and-drop only the block that assigns
// window.loadModel, without swallowing neighboring script tags (the
// importmap, the AR_ASSETS table) that happen to sit between two matches of
// a cruder single spanning regex. Needed because insertEarly always splices
// fresh markup at the very top of <head>; leaving an old helper script tag in
// place would let it execute AFTER the fresh one (document order) and
// silently overwrite window.loadModel back to the old, uncached behavior.
const SCRIPT_BLOCK_RE = /<script[^>]*>[\s\S]*?<\/script>/g;
function stripStaleLoadModelHelper(html: string): string {
  return html.replace(SCRIPT_BLOCK_RE, (block) => (block.includes("window.loadModel =") ? "" : block));
}

// The SECOND black-screen cause (BUG-FIX-LOG 2026-07-23 follow-up, verified in a
// real browser): a 3D game where the model put a <canvas> in the HTML AND let the
// renderer append its own second canvas — the empty leading canvas (in flow, 100%
// height) covers the rendered one. `:not(:last-of-type)` hides only a REDUNDANT
// leading canvas in the same parent; the renderer's (last) canvas — or a sole
// canvas — is always kept, so a correctly-built game is untouched.
const CANVAS_FLOOR_ID = "ari-3d-canvas-floor";
const CANVAS_FLOOR = `<style>/*${CANVAS_FLOOR_ID}*/canvas:not(:last-of-type){display:none!important}</style>`;

/**
 * Guarantees a 3D game can resolve `"three"` and `loadModel` regardless of which
 * pipeline produced the HTML. Returns the input byte-identical when nothing is
 * needed (a plain 2D game, or HTML already correctly injected).
 *
 * Rules:
 *  1. If the game uses three (imports it, calls loadModel, or still carries the
 *     marker) and does NOT already map "three" to our engine URL, ensure exactly
 *     ONE import map → our engine. Any other import map (e.g. a model-invented
 *     CDN map that the browser can't reach behind CSP) is REPLACED, never added
 *     alongside — a second import map is ignored by the browser.
 *  2. If the game calls loadModel but the helper is absent, inject the helper and
 *     an AR_ASSETS table recovered from the loadModel("name") call sites, resolved
 *     against the manifest. Hallucinated names simply don't appear (loadModel then
 *     returns null → fail-soft, the game keeps its placeholder).
 */
export function ensureAssetRuntime(html: string, manifest: AssetManifest = manifestJson as AssetManifest): string {
  const usesThree = IMPORTS_THREE_RE.test(html) || html.includes(THREE_MARKER);
  const usesLoadModel = CALLS_LOADMODEL_RE.test(html);
  const usesPhysics = IMPORTS_CANNON_RE.test(html) || html.includes(PHYSICS_MARKER);
  if (!usesThree && !usesLoadModel && !usesPhysics) return html; // plain 2D — identity

  // By NAME, never by type — two engine-type rows exist since 2026-07-29.
  const engine = manifest.assets.find((a) => a.type === "engine" && a.name === "three");
  const physics = usesPhysics
    ? manifest.assets.find((a) => a.type === "engine" && a.name === "physics")
    : undefined;
  // A physics-only 2D game needs no three bundle, so don't demand one.
  if (!engine && !physics) return html; // can't help — fail-soft, unchanged

  let out = html;
  let markup = "";

  // (1) import map — the actual crash. loadModel's helper also imports three, so
  // either signal requires the map. Keep it ONLY when there's exactly one map and
  // it's ours; a foreign/CDN map (a model-invented unpkg import map — the "still
  // broken" turns) or a second map alongside ours is stripped and replaced, because
  // a document may have only ONE import map (a second is discarded by the browser).
  const imports: Record<string, string> = {};
  if (engine && (usesThree || usesLoadModel)) imports.three = engine.url;
  if (physics) imports["cannon-es"] = physics.url;
  const maps = [...out.matchAll(ANY_IMPORTMAP_RE)];
  const wanted = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
  const singleOursAlready = maps.length === 1 && maps[0]![0] === wanted;
  if (!singleOursAlready) {
    out = out.replace(ANY_IMPORTMAP_RE, "");
    markup += wanted;
  }

  // (2) redundant-canvas floor — CSS only, idempotent, never hides the sole canvas.
  if (!out.includes(CANVAS_FLOOR_ID)) {
    markup += CANVAS_FLOOR;
  }

  // (2b) frame governor (2026-07-29) — pause while hidden + cap to 60fps. This
  // is the ONLY path that reaches games that already exist: the playbook's
  // pause/cap rules land in fresh builds, but an edit is a minimal patch and
  // never retrofits a loop the child didn't ask about. Runs on every preview
  // render (ArtifactFrame), so old stored HTML gets it too.
  if (!out.includes("__arFrameGovernor")) {
    markup += frameGovernor();
  }

  // (3) the AR_ASSETS table — healed UNCONDITIONALLY when the game calls
  // loadModel (BUG-FIX-LOG 2026-08-06, the Sky Patrol bikes): edit turns used
  // to leave a SECOND, stale table later in document order that overwrote the
  // fresh one and erased every model added mid-game. This floor runs on every
  // preview render, so it is the path that repairs games already stored with
  // the duplicate. The healthy table is the UNION of every table present
  // (earliest = newest wins — insertEarly prepends) plus any literally-called
  // manifest models; names are re-resolved against the current manifest.
  // A single already-complete table is left byte-identical.
  if (usesLoadModel) {
    const tables = parseAssetTables(out);
    const union: Record<string, string> = {};
    for (const t of [...tables].reverse()) Object.assign(union, t);
    const urlByName = new Map(manifest.assets.map((a) => [a.name, a.url] as const));
    for (const m of html.matchAll(LOADMODEL_ARG_RE)) {
      const name = m[1]!.toLowerCase();
      const url = urlByName.get(name);
      if (url) union[name] = url; // unknown/hallucinated names omitted → loadModel returns null
    }
    for (const name of Object.keys(union)) {
      const current = urlByName.get(name);
      if (current) union[name] = current; // manifest is the source of truth for known names
    }
    const single = countAssetTables(out) === 1 ? tables[0] : undefined;
    const alreadyHealthy =
      single !== undefined &&
      Object.keys(single).length === Object.keys(union).length &&
      Object.keys(union).every((k) => single[k] === union[k]);
    if (!alreadyHealthy) {
      out = stripAssetTables(out);
      markup += `<script>window.AR_ASSETS=${JSON.stringify(union)};</script>`;
    }

    // (3c) the AR_SIZES table — the measured metres behind modelSize()
    // (2026-08-08, BUG-FIX-LOG fragmented race tracks). Without this branch the
    // v4 helper below retrofits onto a stored game with an EMPTY table and
    // modelSize() answers null for everything, which is the bug again.
    //
    // Fully DERIVED from the manifest plus the union names resolved above, so
    // there is nothing to recover from the document — unlike AR_ASSETS, a stale
    // table here is simply replaced. Skinned models carry no size and are
    // absent by construction.
    const sizeByName = new Map(
      manifest.assets.flatMap((a) => (a.type === "model" && a.size ? [[a.name, a.size] as const] : [])),
    );
    const sizes: Record<string, [number, number, number]> = {};
    for (const name of Object.keys(union)) {
      const s = sizeByName.get(name);
      if (s) sizes[name] = s;
    }
    // A stringify compare is exact here (where AR_ASSETS needs a key-by-key
    // one): both sides are built by iterating Object.keys(union) in the same
    // order, so a healthy game re-serializes byte-identically and is left
    // alone — which is what keeps ensureAssetRuntime idempotent.
    const singleSizes = countSizeTables(out) === 1 ? parseSizeTables(out)[0] : undefined;
    if (singleSizes === undefined || JSON.stringify(singleSizes) !== JSON.stringify(sizes)) {
      out = stripSizeTables(out);
      if (Object.keys(sizes).length > 0) {
        markup += `<script>window.AR_SIZES=${JSON.stringify(sizes)};</script>`;
      }
    }

    // (3d) the AR_AXES table — which axis each path piece runs along, behind
    // modelAxis() (2026-08-08, BUG-FIX-LOG poorly-formed race track). Same
    // reasoning as (3c): the v5 helper retrofits onto stored games, and
    // without the table it would answer null for everything — i.e. the bug.
    // Derived from the manifest; undeclared pieces are absent by construction.
    const axisByName = new Map(
      manifest.assets.flatMap((a) => (a.type === "model" && a.pathAxis ? [[a.name, a.pathAxis] as const] : [])),
    );
    const axes: Record<string, string> = {};
    for (const name of Object.keys(union)) {
      const ax = axisByName.get(name);
      if (ax) axes[name] = ax;
    }
    const singleAxes = countAxisTables(out) === 1 ? parseAxisTables(out)[0] : undefined;
    if (singleAxes === undefined || JSON.stringify(singleAxes) !== JSON.stringify(axes)) {
      out = stripAxisTables(out);
      if (Object.keys(axes).length > 0) {
        markup += `<script>window.AR_AXES=${JSON.stringify(axes)};</script>`;
      }
    }
  }

  // (3a) loadModel helper — inject when the game calls it and either the
  // helper is entirely absent, or present but STALE (an older
  // LOAD_MODEL_HELPER_VERSION than this build teaches — e.g. a game published
  // before the 2026-08-05 template-cache change). A stale helper is stripped
  // first, never left alongside the fresh one.
  if (usesLoadModel && !hasCurrentHelper(out)) {
    if (HAS_HELPER_RE.test(out)) {
      out = stripStaleLoadModelHelper(out);
    }
    markup += loadModelHelper();
  }

  // (3b) loadModelBatch scaffolding — the bulk-instancing counterpart, only
  // injected when the game actually calls it (most games won't).
  if (usesLoadModel && CALLS_LOADMODELBATCH_RE.test(out) && !HAS_LOADMODELBATCH_HELPER_RE.test(out)) {
    markup += loadModelBatchHelper();
  }

  const floored = markup ? insertEarly(out, markup) : out;

  // (4) perf probe (2026-07-30, PRD-PREVIEW-PERF-PANEL) — debug-only
  // per-model load telemetry (window.__arPerf → postMessage). Checked
  // UNCONDITIONALLY, same as the frame governor: this is the only path that
  // reaches a 3D game that already exists (ArtifactFrame re-floors every
  // preview render), so an old stored game gains the probe automatically the
  // next time it's previewed — no per-game migration. Never kid-facing on its
  // own; the debug tab that reads it is gated in ArtifactFrame.
  // Unconditional since 2026-08-06: injectPerfProbe is itself version-aware
  // (skips only a CURRENT probe, replaces an older one). The old
  // marker-presence guard here short-circuited before the version check ever
  // ran, stranding every stored game on whatever probe it was first given —
  // e.g. v2, which predates the idle/`playing` fix to the slowdown banner.
  return injectPerfProbe(floored);
}
