// The importmap FLOOR (BUG-FIX-LOG 2026-07-23, "3D racing game" incident).
//
// A 3D game whose HTML `import ... from "three"` reaches the preview/verify/
// repair path WITHOUT the injected `<script type="importmap">` crashed with
// `Failed to resolve module specifier "three"` and showed a black screen — the
// model kept "fixing" it forever. Root causes stacked: (a) injectAssets only
// fires on the `<!--USES_THREE-->` marker, so if the model imported three but
// mis-placed/omitted the marker, nothing injected; (b) /api/repair + the client
// preview never re-injected. This floor is marker-INDEPENDENT: whenever the HTML
// actually uses three / loadModel, it guarantees a resolvable importmap (+ the
// loadModel scaffolding), and it is idempotent on already-injected HTML.
import { describe, it, expect } from "vitest";
import { ensureAssetRuntime } from "./ensure-runtime";
import manifestJson from "./manifest.json";
import type { AssetManifest } from "./manifest";

const manifest = manifestJson as AssetManifest;
const ENGINE = manifest.assets.find((a) => a.type === "engine")!.url;
const CAR = manifest.assets.find((a) => a.type === "model" && a.name === "car")!.url;

const page = (body: string) =>
  `<!DOCTYPE html><html><head><title>Game</title></head><body>${body}</body></html>`;

// Matches an importmap whose "three" entry points at the given url.
const mapsThreeTo = (html: string, url: string) => {
  const m = html.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return false;
  try {
    return JSON.parse(m[1]!).imports?.three === url;
  } catch {
    return false;
  }
};
const importmapCount = (html: string) =>
  (html.match(/type=["']importmap["']/gi) ?? []).length;

describe("ensureAssetRuntime — the three-importmap floor", () => {
  it("F.1 bare `import from \"three\"` with NO importmap → injects our engine importmap", () => {
    const raw = page(`<script type="module">import { Scene } from "three"; new Scene();</script>`);
    expect(mapsThreeTo(raw, ENGINE)).toBe(false); // precondition: the crash case
    const out = ensureAssetRuntime(raw);
    expect(mapsThreeTo(out, ENGINE)).toBe(true);
    // Exactly one importmap, and it precedes the game's module script.
    expect(importmapCount(out)).toBe(1);
    expect(out.indexOf('type="importmap"')).toBeLessThan(out.indexOf('type="module"'));
  });

  it("F.2 a plain 2D game (no three, no loadModel) passes through byte-identical", () => {
    const raw = page(`<canvas></canvas><script>const c = document.querySelector("canvas").getContext("2d");</script>`);
    expect(ensureAssetRuntime(raw)).toBe(raw);
  });

  it("F.3 idempotent: a fully-floored 3D game (our map + canvas floor) is unchanged", () => {
    const injected = page(
      `<script type="importmap">${JSON.stringify({ imports: { three: ENGINE } })}</script>` +
        `<style>/*ari-3d-canvas-floor*/canvas:not(:last-of-type){display:none!important}</style>` +
        `<script type="module">import { Scene } from "three";</script>`,
    );
    expect(ensureAssetRuntime(injected)).toBe(injected);
  });

  it("F.4 a model-invented CDN importmap (the 'still broken' turns) is REPLACED with our engine", () => {
    const cdn = page(
      `<script type="importmap">${JSON.stringify({ imports: { three: "https://esm.sh/three" } })}</script>` +
        `<script type="module">import { Scene } from "three";</script>`,
    );
    const out = ensureAssetRuntime(cdn);
    expect(mapsThreeTo(out, ENGINE)).toBe(true);
    expect(out.includes("esm.sh")).toBe(false);
    expect(importmapCount(out)).toBe(1); // never two importmaps (a second is ignored by the browser)
  });

  it("F.5 game calls loadModel(\"car\") but the helper/table are missing → both are floored in", () => {
    const raw = page(
      `<script type="module">import { Scene } from "three"; loadModel("car").then(m => scene.add(m));</script>`,
    );
    const out = ensureAssetRuntime(raw);
    expect(mapsThreeTo(out, ENGINE)).toBe(true);
    expect(out).toContain("window.loadModel"); // the helper
    expect(out).toContain(CAR); // the car URL resolved into AR_ASSETS
  });

  it("F.6 a genuinely unknown model name doesn't crash — absent from the table, real ones stay", () => {
    // NOTE: tree/rock/coin are REAL manifest models (106 exist). Use a name that
    // truly isn't in the catalog to exercise the fail-soft omission path.
    const raw = page(
      `<script type="module">import { Scene } from "three"; loadModel("car"); loadModel("batmobile_xyz");</script>`,
    );
    const out = ensureAssetRuntime(raw);
    const m = out.match(/window\.AR_ASSETS\s*=\s*(\{[\s\S]*?\})\s*;/);
    const table = JSON.parse(m![1]!);
    expect(Object.keys(table)).toEqual(["car"]); // only the real asset; the unknown name is silently absent
  });

  it("F.7 the `<!--USES_THREE-->` marker alone (no import yet) still floors the map", () => {
    const raw = page(`<!--USES_THREE--><script type="module">const x = 1;</script>`);
    expect(mapsThreeTo(ensureAssetRuntime(raw), ENGINE)).toBe(true);
  });

  // The SECOND black-screen cause (BUG-FIX-LOG 2026-07-23 follow-up): the model
  // put a <canvas> in the HTML AND let the renderer append its OWN second canvas.
  // The empty leading canvas (in flow, 100% height) covers the rendered one →
  // black screen even though three loaded fine. The floor hides redundant leading
  // canvases so the renderer's (last) canvas shows. Verified in a real browser.
  it("F.8 a 3D game gets the redundant-canvas CSS floor", () => {
    const raw = page(`<canvas></canvas><script type="module">import { Scene } from "three"; new Scene();</script>`);
    expect(ensureAssetRuntime(raw)).toContain("ari-3d-canvas-floor");
  });

  it("F.9 a plain 2D game does NOT get the canvas floor (it needs its canvas in flow)", () => {
    const raw = page(`<canvas></canvas><script>document.querySelector("canvas").getContext("2d");</script>`);
    expect(ensureAssetRuntime(raw)).not.toContain("ari-3d-canvas-floor");
    expect(ensureAssetRuntime(raw)).toBe(raw); // still byte-identical
  });

  it("F.10 exactly ONE import map survives — a foreign (CDN) map alongside ours is deduped, not left as a pair", () => {
    const both = page(
      `<script type="importmap">${JSON.stringify({ imports: { three: ENGINE } })}</script>` +
        `<script type="importmap">${JSON.stringify({ imports: { three: "https://unpkg.com/three" } })}</script>` +
        `<script type="module">import { Scene } from "three";</script>`,
    );
    const out = ensureAssetRuntime(both);
    expect(importmapCount(out)).toBe(1);
    expect(mapsThreeTo(out, ENGINE)).toBe(true);
    expect(out.includes("unpkg")).toBe(false);
  });

  it("F.11 idempotent on a fully-floored 3D game — no duplicate style or map", () => {
    const once = ensureAssetRuntime(
      page(`<canvas></canvas><script type="module">import { Scene } from "three"; loadModel("car");</script>`),
    );
    expect(ensureAssetRuntime(once)).toBe(once);
    expect((once.match(/ari-3d-canvas-floor/g) ?? []).length).toBe(1);
  });
});
