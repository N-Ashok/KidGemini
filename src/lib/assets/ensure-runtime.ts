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
import { insertEarly, loadModelHelper, frameGovernor } from "./runtime-helpers";

const IMPORTS_THREE_RE = /\bfrom\s*["']three["']/;
// Physics games import the second engine by its own bare specifier; an
// unmapped one dies on the import line exactly like an unmapped "three".
const IMPORTS_CANNON_RE = /\bfrom\s*["']cannon-es["']/;
const CALLS_LOADMODEL_RE = /\bloadModel\s*\(/;
const LOADMODEL_ARG_RE = /\bloadModel\s*\(\s*["']([a-z0-9_]+)["']/gi;
const ANY_IMPORTMAP_RE = /<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;
const HAS_HELPER_RE = /window\.loadModel\s*=/;
const HAS_AR_ASSETS_RE = /window\.AR_ASSETS\s*=/;

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

  // (3) loadModel scaffolding — only when the game calls it but the helper is gone.
  if (usesLoadModel && !HAS_HELPER_RE.test(out)) {
    if (!HAS_AR_ASSETS_RE.test(out)) {
      const modelsByName = new Map(
        manifest.assets.filter((a) => a.type === "model").map((a) => [a.name, a.url] as const),
      );
      const table: Record<string, string> = {};
      for (const m of html.matchAll(LOADMODEL_ARG_RE)) {
        const name = m[1]!.toLowerCase();
        const url = modelsByName.get(name);
        if (url) table[name] = url; // unknown/hallucinated names omitted → loadModel returns null
      }
      markup += `<script>window.AR_ASSETS=${JSON.stringify(table)};</script>`;
    }
    markup += loadModelHelper();
  }

  if (!markup) return html; // already fully floored — identity
  return insertEarly(out, markup);
}
