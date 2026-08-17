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
import { ensureStorageShim } from "./storage-shim";
import type { AssetManifest } from "./manifest";
import { THREE_MARKER, PHYSICS_MARKER } from "./markers";
import {
  buildResolutionGovernorScript,
  hasCurrentResolutionGovernor,
  stripStaleResolutionGovernor,
} from "./resolution-governor";
import {
  insertEarly,
  loadModelHelper,
  loadModelBatchHelper,
  LOAD_MODEL_BATCH_VERSION,
  frameGovernor,
  webglContextGuard,
  WEBGL_GUARD_VERSION,
  LOAD_MODEL_HELPER_VERSION,
  MODEL_RUNTIME_GLOBALS,
  parseAssetTables,
  stripAssetTables,
  countAssetTables,
  parseSizeTables,
  stripSizeTables,
  countSizeTables,
  countAxisTables,
  parseAxisTables,
  stripAxisTables,
  countEdgeTables,
  parseFacingTables,
  stripFacingTables,
  countFacingTables,
  parseRealTables,
  stripRealTables,
  countRealTables,
  parseEdgeTables,
  stripEdgeTables,
} from "./runtime-helpers";
import { injectPerfProbe } from "./perf-probe";
import { resolveModelName } from "./model-alias";

const IMPORTS_THREE_RE = /\bfrom\s*["']three["']/;
// Physics games import the second engine by its own bare specifier; an
// unmapped one dies on the import line exactly like an unmapped "three".
const IMPORTS_CANNON_RE = /\bfrom\s*["']cannon-es["']/;
// ANY of the model APIs pulls the helper in — they all live in the same
// injected block and all depend on loadModel internally.
//
// This used to be `/\bloadModel\s*\(/` alone, which matches neither
// `placeModel(` nor `loadModelBatch(` nor `modelHeading(`. That was survivable
// while loadModel was the only API a game called, and became a live bug on
// 2026-08-15 when the prompt started telling the model to PREFER placeModel:
// a game that used placeModel and never wrote the literal `loadModel(` got no
// helper injected at all and died on `placeModel is not defined`. Found by a
// round-trip test (strip -> re-floor), not in production, but it was already
// deployed.
// DERIVED from the MODEL half of the shared list (2026-08-17) — deliberately
// NOT the full INJECTED_RUNTIME_GLOBALS, which also carries playSound and
// playMusic. Audio is not 3D: a 2D game that plays a coin sound must never be
// handed an import map and a module script importing "three". Using the full
// list here did exactly that and shipped (BUG-FIX-LOG 2026-08-17); F.22-F.24
// are the floor that keeps 2D out of this branch. Otherwise: derived, not
// was a third private copy of the injected-globals list, and the copies had
// already drifted apart once (KNOWN_BUGS #21). Building the regex from
// INJECTED_RUNTIME_GLOBALS means a helper added there is automatically
// recognised here, instead of a game that calls it getting no runtime at all
// and dying on `<name> is not defined` — precisely the 2026-08-15 placeModel
// failure this line's own comment describes below.
const CALLS_LOADMODEL_RE = new RegExp(`\\b(?:${MODEL_RUNTIME_GLOBALS.join("|")})\\s*\\(`);
const CALLS_LOADMODELBATCH_RE = /\bloadModelBatch\s*\(/;
// BOTH loader shapes (BUG_LOG 2026-08-17). `loadModelBatch` was invisible here
// for as long as it has existed: `\bloadModel\s*\(` cannot match
// `loadModelBatch("car", 60)`, because after `loadModel` comes `Batch`, not
// `(`. Batching is how a game makes CROWDS — traffic, fleets, city blocks — so
// the single call shape most likely to carry a newly-added model had no
// healing at all, and on an edit turn (where the asset markers have been
// stripped from the source) healing is the ONLY way a new model reaches
// AR_ASSETS. The failure was silent end to end: loadModelBatch returns null,
// the game's own `if (batch)` skips, and nothing appears.
const LOADMODEL_ARG_RE = /\bloadModel(?:Batch)?\s*\(\s*["']([a-z0-9_]+)["']/gi;
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

// Same shape as HELPER_VERSION_RE/hasCurrentHelper/stripStaleLoadModelHelper
// above (2026-08-11 — see the (2c) comment at the call site for why this
// needed to exist at all).
const GL_GUARD_VERSION_RE = /window\.__arGlGuardVersion\s*=\s*(\d+)/;
function hasCurrentGlGuard(html: string): boolean {
  const m = html.match(GL_GUARD_VERSION_RE);
  return !!m && Number(m[1]) >= WEBGL_GUARD_VERSION;
}
function stripStaleGlGuard(html: string): string {
  return html.replace(SCRIPT_BLOCK_RE, (block) => (block.includes("window.__arGlGuard") ? "" : block));
}

// Same pair for the loadModelBatch helper (2026-08-15). v1 shipped unstamped,
// so "no stamp" must read as stale, not as absent — an unstamped copy is
// precisely the broken one.
const BATCH_HELPER_VERSION_RE = /window\.__arLoadModelBatchVersion\s*=\s*(\d+)/;
function hasCurrentBatchHelper(html: string): boolean {
  const m = html.match(BATCH_HELPER_VERSION_RE);
  return !!m && Number(m[1]) >= LOAD_MODEL_BATCH_VERSION;
}
function stripStaleBatchHelper(html: string): string {
  return html.replace(SCRIPT_BLOCK_RE, (block) => (block.includes("window.loadModelBatch =") ? "" : block));
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

  // The storage shim is NOT part of the 3D floor and must be applied first:
  // the game it saves is usually a plain 2D one, which every line below this
  // point declines to touch. A 2D game that reads a saved high score throws in
  // the opaque-origin preview iframe and dies at init — title screen up, Start
  // button dead (see storage-shim.ts).
  html = ensureStorageShim(html);

  if (!usesThree && !usesLoadModel && !usesPhysics) return html; // plain 2D — identity (plus any shim)

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
  // A map that EXISTS and is byte-perfect can still be in the WRONG PLACE, and
  // a misplaced map is as fatal as a missing one — the browser ignores any
  // import map that appears after module resolution has begun. Stored games
  // that were written with the map below a module script are permanently
  // broken until something moves it, and nothing did: every other check in
  // this function asks "is it present and correct", never "is it early
  // enough". That is why the 2026-08-09 outage survived a redeploy.
  const firstModuleIdx = out.search(/<script[^>]*type=["']module["']/i);
  const firstMapIdx = maps.length ? maps[0]!.index! : -1;
  const mapAfterModule = firstMapIdx >= 0 && firstModuleIdx >= 0 && firstMapIdx > firstModuleIdx;
  if (!singleOursAlready || mapAfterModule) {
    out = out.replace(ANY_IMPORTMAP_RE, "");
  }
  // NOT added to `markup` here — the decision moves to the bottom of this
  // function, because whether the map must be re-emitted depends on whether
  // ANYTHING ELSE gets prepended. See "the import-map ordering invariant"
  // below (BUG-FIX-LOG 2026-08-09, the production outage).
  let mapNeedsReemit = !singleOursAlready || mapAfterModule;

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

  // (2c) WebGL context guard (2026-08-10) — survive an eviction instead of
  // going permanently blank, and release the GPU on teardown so a session of
  // edits stops accumulating contexts. Same reasoning as the governor above:
  // this is the only path that reaches games that already exist. Version-
  // aware since 2026-08-11 (WEBGL_GUARD_VERSION) — the bare presence check
  // this used to be (`!out.includes("__arGlGuard")`) is the EXACT bug
  // perf-probe's own comment already named ("presence alone used to be
  // treated as done"): a game whose guard was baked in before ANY later fix
  // to this function was frozen on that version forever, surviving both
  // edits and deploys — found investigating an owner report where a fix
  // never reached the game being tested against.
  if (!hasCurrentGlGuard(out)) {
    if (out.includes("__arGlGuard")) out = stripStaleGlGuard(out);
    markup += webglContextGuard();
  }

  // (2d) adaptive resolution governor (2026-08-15) — spend only as many pixels
  // as the device can actually shade. The owner's Chromebook ran a 24-mesh,
  // 63k-triangle, 23-draw-call game at 14-28fps purely on fill cost; the same
  // scene at half the pixels doubles its frame rate. Like the two above, this
  // is the only path that reaches the games that already exist.
  if (!hasCurrentResolutionGovernor(out)) {
    if (out.includes("__arResGovernor")) out = stripStaleResolutionGovernor(out);
    markup += buildResolutionGovernorScript();
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
    const availableNames = new Set(
      manifest.assets.filter((a) => a.type === "model").map((a) => a.name),
    );
    for (const m of html.matchAll(LOADMODEL_ARG_RE)) {
      const name = m[1]!.toLowerCase();
      const url = urlByName.get(name);
      if (url) {
        union[name] = url;
        continue;
      }
      // A name we do not have. Before giving up (which leaves loadModel
      // returning null and the child looking at a hand-built placeholder),
      // try to resolve it onto a real model — deterministically, no extra
      // model call. Measured across every stored game: 2 of 99 distinct names
      // were invented, `stegosaurus` x5 and `mermaid` x1. The first should
      // simply be `dino`; the second correctly stays unmatched.
      //
      // The INVENTED name stays the key, so the game's own
      // `loadModel("stegosaurus")` keeps working untouched — only the URL
      // behind it becomes real. Nothing in the child's code is rewritten.
      const resolved = resolveModelName(name, availableNames);
      if (resolved.name) {
        const resolvedUrl = urlByName.get(resolved.name);
        if (resolvedUrl) union[name] = resolvedUrl;
      }
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

    // (3e) the AR_EDGES table — which edges each tile's road reaches, behind
    // modelJoins() (2026-08-09, BUG-FIX-LOG the second poorly-formed track).
    // This block IS the migration for the reported bug: every stored 3D game
    // picks the corner data up on its next preview render, so a child who
    // re-opens the broken race track and asks for a fix gets a model that can
    // finally answer "which way does this corner turn". No restamp campaign
    // (PRD §2.4). Unmeasured pieces are absent by construction, so an admitted
    // gap stays a gap instead of becoming a confident wrong answer.
    const edgeByName = new Map(
      manifest.assets.flatMap((a) =>
        a.type === "model" && a.joins?.length
          ? [[a.name, { joins: a.joins, lane: a.lane, at: a.joinOffsets }] as const]
          : [],
      ),
    );
    const edges: Record<string, unknown> = {};
    for (const name of Object.keys(union)) {
      const ed = edgeByName.get(name);
      if (ed) edges[name] = ed;
    }
    const singleEdges = countEdgeTables(out) === 1 ? parseEdgeTables(out)[0] : undefined;
    if (singleEdges === undefined || JSON.stringify(singleEdges) !== JSON.stringify(edges)) {
      out = stripEdgeTables(out);
      if (Object.keys(edges).length > 0) {
        markup += `<script>window.AR_EDGES=${JSON.stringify(edges)};</script>`;
      }
    }

    // (3f) the AR_FACING table — which way each model's front points, behind
    // modelFacing() and placeModel() (2026-08-15). Same reasoning as (3d):
    // the v8 helper retrofits onto stored games, and without the table it
    // would answer null for everything — i.e. the bug it exists to fix.
    const facingByName = new Map(
      manifest.assets.flatMap((a) => (a.type === "model" && a.facing ? [[a.name, a.facing] as const] : [])),
    );
    const facings: Record<string, string> = {};
    for (const name of Object.keys(union)) {
      const f = facingByName.get(name);
      if (f) facings[name] = f;
    }
    const singleFacings = countFacingTables(out) === 1 ? parseFacingTables(out)[0] : undefined;
    if (singleFacings === undefined || JSON.stringify(singleFacings) !== JSON.stringify(facings)) {
      out = stripFacingTables(out);
      if (Object.keys(facings).length > 0) {
        markup += `<script>window.AR_FACING=${JSON.stringify(facings)};</script>`;
      }
    }

    // (3g) the AR_REAL table — each model's true real-world size, behind
    // modelMetres() (2026-08-15). AR_SIZES stays exactly as it is: live games
    // divide by those numbers, so they cannot be redefined under them.
    const realByName = new Map(
      manifest.assets.flatMap((a) => (a.type === "model" && a.realSize ? [[a.name, a.realSize] as const] : [])),
    );
    const reals: Record<string, [number, number, number]> = {};
    for (const name of Object.keys(union)) {
      const r = realByName.get(name);
      if (r) reals[name] = r;
    }
    const singleReals = countRealTables(out) === 1 ? parseRealTables(out)[0] : undefined;
    if (singleReals === undefined || JSON.stringify(singleReals) !== JSON.stringify(reals)) {
      out = stripRealTables(out);
      if (Object.keys(reals).length > 0) {
        markup += `<script>window.AR_REAL=${JSON.stringify(reals)};</script>`;
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
  //
  // Version-aware since 2026-08-15. This used to gate on the helper merely
  // being PRESENT, which is the same trap that froze the WebGL guard on ~200
  // stored games (2026-08-11) and the perf probe before it: any game that
  // already carried the helper kept its ORIGINAL copy forever, through every
  // edit and every deploy. That mattered the moment v1 turned out to place
  // every batched prop rotated and sunk — the games needing the fix are
  // exactly the ones a presence check would skip.
  if (usesLoadModel && CALLS_LOADMODELBATCH_RE.test(out) && !hasCurrentBatchHelper(out)) {
    if (HAS_LOADMODELBATCH_HELPER_RE.test(out)) out = stripStaleBatchHelper(out);
    markup += loadModelBatchHelper();
  }

  // ── the import-map ordering invariant ──────────────────────────────────
  // insertEarly splices `markup` at the VERY TOP of <head>, and several things
  // it can carry are `<script type="module">` that import "three" — the
  // loadModel and loadModelBatch helpers. An import map must precede EVERY
  // module load in the document; a browser silently ignores one that appears
  // after resolution has begun.
  //
  // So it is not enough for the map to EXIST and be correct — it must sit
  // above whatever we are about to prepend. A stored game keeps its map
  // wherever it was written, which is typically deep in the body, far below
  // the insertion point.
  //
  // This was latent until the v5→v6 helper bump (2026-08-09) made the helper
  // stale for EVERY stored 3D game at once: each one re-injected a module
  // script ~8.5 KB above its own perfectly valid import map, and every 3D game
  // in production failed with `Failed to resolve module specifier "three"`
  // followed by `loadModel is not defined`. The map was never the thing that
  // was wrong — its POSITION was.
  //
  // Guarded on `markup` being non-empty, so a document that is already current
  // is still returned byte-identical and the map is never pointlessly moved.
  if (markup && !mapNeedsReemit && Object.keys(imports).length > 0) {
    out = out.replace(ANY_IMPORTMAP_RE, "");
    mapNeedsReemit = true;
  }
  if (mapNeedsReemit && (Object.keys(imports).length > 0 || markup)) {
    // FIRST in markup, so it precedes every helper we are prepending.
    markup = wanted + markup;
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
