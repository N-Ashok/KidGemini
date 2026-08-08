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
import { PERF_PROBE_MARKER, buildPerfProbeScript } from "./perf-probe";
import manifestJson from "./manifest.json";
import type { AssetManifest } from "./manifest";
import { countSizeTables, parseSizeTables } from "./runtime-helpers";

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

  it("F.3 idempotent: a fully-floored 3D game is unchanged", () => {
    // The floor grew a fourth element on 2026-07-30 (the perf probe), so
    // "fully floored" now includes it too (2026-07-29 added the governor).
    // The property under test is unchanged: running the floor over
    // already-floored HTML must be a no-op.
    const injected = page(
      `<script type="importmap">${JSON.stringify({ imports: { three: ENGINE } })}</script>` +
        `<style>/*ari-3d-canvas-floor*/canvas:not(:last-of-type){display:none!important}</style>` +
        `<script>window.__arFrameGovernor = 1;</script>` +
        `${PERF_PROBE_MARKER}<script>${buildPerfProbeScript()}</script>` +
        `<script type="module">import { Scene } from "three";</script>`,
    );
    expect(ensureAssetRuntime(injected)).toBe(injected);
  });

  it("F.3b a game floored BEFORE the governor existed gains one (this is what reaches old games)", () => {
    // Every previously-stored game looks like this. ArtifactFrame re-floors on
    // each preview render, which is the only route by which a game that already
    // exists ever gets the pause + 60fps cap.
    const preGovernor = page(
      `<script type="importmap">${JSON.stringify({ imports: { three: ENGINE } })}</script>` +
        `<style>/*ari-3d-canvas-floor*/canvas:not(:last-of-type){display:none!important}</style>` +
        `<script type="module">import { Scene } from "three";</script>`,
    );
    const out = ensureAssetRuntime(preGovernor);
    expect(out).toMatch(/__arFrameGovernor = 1/);
    expect(ensureAssetRuntime(out)).toBe(out); // and settles immediately
  });

  it("F.3c a game floored BEFORE the perf probe existed gains one too (2026-07-30, same precedent)", () => {
    const prePerfProbe = page(
      `<script type="importmap">${JSON.stringify({ imports: { three: ENGINE } })}</script>` +
        `<style>/*ari-3d-canvas-floor*/canvas:not(:last-of-type){display:none!important}</style>` +
        `<script>window.__arFrameGovernor = 1;</script>` +
        `<script type="module">import { Scene } from "three";</script>`,
    );
    const out = ensureAssetRuntime(prePerfProbe);
    expect(out).toContain(PERF_PROBE_MARKER);
    expect(ensureAssetRuntime(out)).toBe(out); // and settles immediately
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
    expect((once.match(new RegExp(PERF_PROBE_MARKER)) ?? []).length).toBe(1);
  });

  it("F.12 the perf probe is present on any 3D game, and absent on a plain 2D game", () => {
    const threeD = ensureAssetRuntime(page(`<script type="module">import { Scene } from "three";</script>`));
    expect(threeD).toContain(PERF_PROBE_MARKER);
    const flat = page(`<canvas></canvas><script>document.querySelector("canvas").getContext("2d");</script>`);
    expect(ensureAssetRuntime(flat)).not.toContain(PERF_PROBE_MARKER);
  });

  // F.13/F.14 — 2026-08-05 global 3D slowdown fix (TECH_DEBT): loadModelHelper()
  // gained a template cache, which only helps a game whose CURRENT helper is at
  // least that version. A game published before this change already has an OLD
  // window.loadModel = ... baked in from inject.ts's publish-time run, and
  // ensure-runtime.ts is the ONLY path that ever reaches it again (re-floors on
  // every preview render) — so the version-marker retrofit here is what makes
  // the fix actually reach already-published games, not just new ones.
  it("F.13 a game with an OLD (pre-cache, unversioned) loadModel helper gets it replaced with the current one", () => {
    const staleHelper = `<script type="module">
  import { GLTFLoader, MeshoptDecoder } from "three";
  const __arLoader = new GLTFLoader();
__arLoader.setMeshoptDecoder(MeshoptDecoder);
window.__arPerf = window.__arPerf || { models: {}, rootNames: new WeakMap(), animatedRoots: new WeakSet(), renderer: null };
window.loadModel = async function (name) {
  return null;
};
</script>`;
    const stale = page(
      `<script type="importmap">${JSON.stringify({ imports: { three: ENGINE } })}</script>` +
        `<script>window.AR_ASSETS=${JSON.stringify({ car: CAR })};</script>` +
        staleHelper +
        `<script type="module">import { Scene } from "three"; loadModel("car");</script>`,
    );
    const out = ensureAssetRuntime(stale);
    expect(out).toMatch(/window\.__arLoadModelVersion\s*=/); // gained the version stamp
    expect(out).toContain("__arStaticTemplates"); // gained the template cache
    // Exactly one window.loadModel assignment survives — the stale one was
    // stripped, not left alongside the fresh one (would silently re-clobber it
    // back to the old behavior, since the old script would then run LAST).
    expect(out.match(/window\.loadModel\s*=/g)?.length).toBe(1);
    expect(ensureAssetRuntime(out)).toBe(out); // and settles immediately
  });

  it("F.14 a game calling loadModelBatch gets the batch helper floored in alongside loadModel", () => {
    const raw = page(
      `<script type="module">import { Scene } from "three"; loadModel("tree"); loadModelBatch("tree", 40).then(b => { if (b) scene.add(b.mesh); });</script>`,
    );
    const out = ensureAssetRuntime(raw);
    expect(out).toContain("window.loadModelBatch");
    expect(ensureAssetRuntime(out)).toBe(out); // idempotent
  });

  it("F.15 a game that only calls loadModel (no batch) does NOT get the batch helper floored in", () => {
    const raw = page(`<script type="module">import { Scene } from "three"; loadModel("car");</script>`);
    const out = ensureAssetRuntime(raw);
    expect(out).not.toContain("window.loadModelBatch");
  });

  // F.16-F.18 — 2026-08-08, BUG-FIX-LOG fragmented race tracks. A generated
  // racer laid 1 m road tiles at 10 m intervals because no dimension data
  // existed anywhere it could reach. modelSize() is the fix, and THIS is the
  // path that carries it to games that already exist: every stored 3D game
  // re-floors on its next preview render, so the v3→v4 helper bump plus the
  // AR_SIZES table retrofits the capability with no migration.
  it("F.16 a stored game with a v3 helper and no sizes table gains BOTH modelSize and the metres it reads", () => {
    const v3Helper = `<script type="module">
  import { GLTFLoader, MeshoptDecoder } from "three";
  window.__arLoadModelVersion = 3;
window.loadModel = async function (name) { return null; };
</script>`;
    const stored = page(
      `<script type="importmap">${JSON.stringify({ imports: { three: ENGINE } })}</script>` +
        `<script>window.AR_ASSETS=${JSON.stringify({ car: CAR })};</script>` +
        v3Helper +
        `<script type="module">import { Scene } from "three"; loadModel("car");</script>`,
    );
    const out = ensureAssetRuntime(stored);
    expect(out).toContain("window.__arLoadModelVersion = 6");
    expect(out).toContain("window.modelSize");
    // The helper alone would be useless — it must find real metres to read.
    const carSize = manifest.assets.find((a) => a.name === "car")!.size;
    expect(countSizeTables(out)).toBe(1);
    expect(parseSizeTables(out)[0]).toEqual(carSize ? { car: carSize } : {});
    // The stale v3 block was stripped, not left alongside the fresh one.
    expect(out.match(/window\.loadModel\s*=/g)?.length).toBe(1);
    expect(ensureAssetRuntime(out)).toBe(out); // and settles immediately
  });

  it("F.17 stays idempotent on a game that already carries a correct sizes table", () => {
    const once = ensureAssetRuntime(
      page(`<canvas></canvas><script type="module">import { Scene } from "three"; loadModel("car");</script>`),
    );
    expect(ensureAssetRuntime(once)).toBe(once);
    expect(countSizeTables(once)).toBeLessThanOrEqual(1);
  });

  it("F.18 replaces a STALE sizes table rather than leaving it to win by document order", () => {
    // A wrong footprint is worse than none — a game stepping it tiles into the
    // wrong place with full confidence.
    const stale = page(
      `<script>window.AR_ASSETS=${JSON.stringify({ car: CAR })};</script>` +
        `<script>window.AR_SIZES=${JSON.stringify({ car: [99, 99, 99] })};</script>` +
        `<script type="module">import { Scene } from "three"; loadModel("car");</script>`,
    );
    const out = ensureAssetRuntime(stale);
    expect(countSizeTables(out)).toBe(1);
    expect(parseSizeTables(out)[0]).not.toEqual({ car: [99, 99, 99] });
  });

  it("F.19 leaves a plain 2D game byte-identical — no sizes table for a game with no models", () => {
    const flat = page(`<canvas></canvas><script>document.querySelector("canvas").getContext("2d");</script>`);
    expect(ensureAssetRuntime(flat)).not.toContain("window.AR_SIZES=");
  });
});

// BUG-FIX-LOG 2026-08-06 (Sky Patrol: bikes never appeared). Edit turns used
// to leave TWO AR_ASSETS tables in the stored artifact — the stale one sat
// later in document order and overwrote the fresh one, erasing every model
// added mid-game. The floor runs on EVERY preview render, so fixing the table
// here heals already-broken stored games with no new chat turn. Same class:
// the perf probe was skip-if-present at this call site, stranding old games
// on a probe version whose bugs were already fixed.
describe("ensureAssetRuntime — asset-table healing (2026-08-06)", () => {
  const STREET = manifest.assets.find((a) => a.type === "model" && a.name === "street_motorcycle")!.url;
  const tableBlocks = (html: string) => html.match(/window\.AR_ASSETS\s*=/g) ?? [];
  const tableOf = (html: string) => {
    const m = html.match(/window\.AR_ASSETS\s*=\s*(\{[\s\S]*?\})\s*;/);
    return JSON.parse(m![1]!) as Record<string, string>;
  };
  // The real Sky Patrol shape: models chosen from an ARRAY, so no literal
  // loadModel("street_motorcycle") call site exists to recover names from —
  // the tables themselves are the only record of what the game may load.
  const dynamicGame = (tables: string) =>
    page(
      `${tables}<script type="module">import { Scene } from "three"; const kinds=["street_motorcycle","car"]; loadModel(kinds[i]);</script>`,
    );

  it("H.1 duplicate tables collapse to ONE holding the union (fresh names must survive)", () => {
    const fresh = `<script>window.AR_ASSETS=${JSON.stringify({ car: CAR, street_motorcycle: STREET })};</script>`;
    const stale = `<script>window.AR_ASSETS=${JSON.stringify({ car: CAR })};</script>`;
    const out = ensureAssetRuntime(dynamicGame(fresh + stale));
    expect(tableBlocks(out).length).toBe(1);
    expect(tableOf(out)).toEqual({ car: CAR, street_motorcycle: STREET });
  });

  it("H.2 a single stale table missing a literally-called manifest model gains it", () => {
    const stale = `<script>window.AR_ASSETS=${JSON.stringify({ car: CAR })};</script>`;
    const raw = page(
      `${stale}<script type="module">import { Scene } from "three"; loadModel("car"); loadModel("street_motorcycle");</script>`,
    );
    const out = ensureAssetRuntime(raw);
    expect(tableBlocks(out).length).toBe(1);
    expect(tableOf(out).street_motorcycle).toBe(STREET);
    expect(tableOf(out).car).toBe(CAR);
  });

  it("H.3 a complete single table is left byte-identical (idempotence)", () => {
    const raw = page(
      `<script>window.AR_ASSETS=${JSON.stringify({ car: CAR })};</script><script type="module">import { Scene } from "three"; loadModel("car");</script>`,
    );
    const out = ensureAssetRuntime(raw);
    expect(ensureAssetRuntime(out)).toBe(out);
  });

  it("H.4 an old-version perf probe is REPLACED, not skipped, on the floor pass", () => {
    const oldProbe = `<!--ari-perf-probe--><script>(function(){window.__arPerfProbeVersion = 2;})();</script>`;
    const raw = page(`${oldProbe}<script type="module">import { Scene } from "three"; new Scene();</script>`);
    const out = ensureAssetRuntime(raw);
    expect(out).not.toContain("__arPerfProbeVersion = 2");
    expect(out).toMatch(/__arPerfProbeVersion = [3-9]/);
    expect((out.match(/<!--ari-perf-probe-->/g) ?? []).length).toBe(1); // exactly one probe block
  });
});

// PRODUCTION OUTAGE 2026-08-09 (BUG-FIX-LOG). Every stored 3D game broke with
// `Failed to resolve module specifier "three"` and `loadModel is not defined`.
//
// The import map was PRESENT and byte-identical to ours, so step (1)'s
// `singleOursAlready` left it exactly where it sat — 8,970 bytes into the real
// document. Meanwhile the v5→v6 helper bump made the helper stale, so it was
// re-injected, and insertEarly prepends to the top of <head>. The helper is a
// `<script type="module">` that imports "three", so it ended up ~8.5 KB ABOVE
// the map that resolves it. A browser ignores an import map that appears after
// module resolution has begun.
//
// The flaw was latent for as long as the map has been placed anywhere but the
// top; the version bump activated it for every stored 3D game at once.
describe("the import map must precede every module script we prepend", () => {
  const MAP = `<script type="importmap">${JSON.stringify({ imports: { three: ENGINE } })}</script>`;

  // Mirrors the real stored artifact: a CORRECT, single, ours-already import
  // map sitting deep in the document, below where insertEarly splices.
  const storedWithDeepMap = (helperVersion: number) =>
    `<!DOCTYPE html><html lang="en"><head></head><body>` +
    `<div id="ui">lots of game chrome</div>` +
    `<script>window.AR_ASSETS=${JSON.stringify({ car: CAR })};</script>` +
    MAP +
    `<script type="module">
  import { GLTFLoader } from "three";
  window.__arLoadModelVersion = ${helperVersion};
window.loadModel = async function (name) { return null; };
</script>` +
    `<script type="module">import { Scene } from "three"; loadModel("car");</script>` +
    `</body></html>`;

  const firstIndexOf = (html: string, re: RegExp) => {
    const m = re.exec(html);
    return m ? m.index : -1;
  };

  it("re-emits the map ABOVE the helper when a stale helper is re-injected", () => {
    // A stale helper is exactly what a version bump creates, for every stored
    // game, all at once — so this is the common case, not an edge case.
    const out = ensureAssetRuntime(storedWithDeepMap(3));
    const mapIdx = firstIndexOf(out, /<script[^>]*type=["']importmap["']/i);
    const modIdx = firstIndexOf(out, /<script[^>]*type=["']module["']/i);
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    expect(modIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx, "import map must come before the first module script").toBeLessThan(modIdx);
  });

  it("leaves exactly ONE import map — a second is discarded by the browser", () => {
    const out = ensureAssetRuntime(storedWithDeepMap(3));
    expect([...out.matchAll(/type=["']importmap["']/gi)]).toHaveLength(1);
  });

  it("still touches nothing when the document is already fully current", () => {
    // The map must NOT be pointlessly relocated on every render — that would
    // rewrite every stored game forever and defeat the idempotence check.
    const healed = ensureAssetRuntime(storedWithDeepMap(3));
    expect(ensureAssetRuntime(healed)).toBe(healed);
  });
});
