// Physics-engine wiring contract (2026-07-29, docs/2026-07-29_PRD_Physics.md
// Phase 2). cannon-es is the SECOND engine on the asset host, which breaks an
// assumption both inject.ts and ensure-runtime.ts were built on:
// `assets.find(a => a.type === "engine")` — with two engine rows that returns
// whichever happens to be first in the manifest. Every test here exists to stop
// a game being handed the physics bundle as its Three.js engine, or vice versa.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { injectAssets } from "./inject";
import { ensureAssetRuntime } from "./ensure-runtime";
import { ASSET_HOST_ORIGIN, type AssetEntry, type AssetManifest } from "./manifest";
import { THREE_MARKER, PHYSICS_MARKER } from "./markers";

const sha = (c: string) => c.repeat(64);
function engine(name: string, bytes: number, shaChar: string): AssetEntry {
  return {
    name, type: "engine", bytes,
    url: `${ASSET_HOST_ORIGIN}/${name}.${sha(shaChar).slice(0, 6)}.js`,
    license: "MIT", sourceUrl: "https://example.com/proof", sha256: sha(shaChar),
  };
}

// Deliberately CANNON-FIRST, so a lookup that still says find(type==="engine")
// picks the wrong row and every assertion below fails loudly.
const manifest: AssetManifest = {
  assets: [engine("physics", 92_000, "c"), engine("three", 632_000, "a")],
};

describe("engine lookup is by NAME, not by type (two engines now exist)", () => {
  it("a plain 3D game maps 'three' to the THREE bundle, never the physics one", () => {
    const out = injectAssets(`<body>${THREE_MARKER}<p>hi</p></body>`, manifest);
    const map = JSON.parse(out.html.match(/<script type="importmap">(.*?)<\/script>/)![1]!);
    expect(map.imports.three).toBe(manifest.assets.find((a) => a.name === "three")!.url);
  });

  it("a 3D game with no physics marker does NOT ship the physics bundle", () => {
    const out = injectAssets(`<body>${THREE_MARKER}<p>hi</p></body>`, manifest);
    const map = JSON.parse(out.html.match(/<script type="importmap">(.*?)<\/script>/)![1]!);
    expect(map.imports["cannon-es"]).toBeUndefined();
    expect(out.referencedUrls).not.toContain(manifest.assets.find((a) => a.name === "physics")!.url);
  });
});

describe("USES_PHYSICS marker", () => {
  const html = `<body>${THREE_MARKER}${PHYSICS_MARKER}<p>hi</p></body>`;

  it("maps both bare specifiers so `import { World } from \"cannon-es\"` resolves", () => {
    const out = injectAssets(html, manifest);
    const map = JSON.parse(out.html.match(/<script type="importmap">(.*?)<\/script>/)![1]!);
    expect(map.imports.three).toContain("three.");
    expect(map.imports["cannon-es"]).toContain("physics.");
  });

  it("counts the physics bundle against the first-load budget", () => {
    const out = injectAssets(html, manifest);
    expect(out.referencedUrls).toContain(manifest.assets.find((a) => a.name === "physics")!.url);
  });

  it("is stripped from the delivered HTML like every other marker", () => {
    // Markers must not survive into the stored source — that asymmetry is the
    // whole of KNOWN_BUGS #5. A new marker that skips stripAssetMarkers would
    // reopen it for physics games.
    const out = injectAssets(html, manifest);
    expect(out.html).not.toContain(PHYSICS_MARKER);
  });

  it("physics without 3D still works (a 2D canvas game may want real physics)", () => {
    const out = injectAssets(`<body>${PHYSICS_MARKER}<canvas></canvas></body>`, manifest);
    const map = JSON.parse(out.html.match(/<script type="importmap">(.*?)<\/script>/)![1]!);
    expect(map.imports["cannon-es"]).toContain("physics.");
  });
});

describe("ensureAssetRuntime — the marker-independent floor covers physics too", () => {
  it("a game importing cannon-es with NO marker and NO import map still resolves", () => {
    // Exactly the BUG-FIX-LOG 2026-07-23 failure class that ensure-runtime
    // exists for: `Failed to resolve module specifier` kills the whole script,
    // and no self-healing pass can patch around a dead import line.
    const html = `<body><script type="module">import { World } from "cannon-es";</script></body>`;
    const out = ensureAssetRuntime(html, manifest);
    const map = JSON.parse(out.match(/<script type="importmap">(.*?)<\/script>/)![1]!);
    expect(map.imports["cannon-es"]).toContain("physics.");
  });

  it("is idempotent — running it twice leaves exactly one import map", () => {
    const html = `<body><script type="module">import { World } from "cannon-es";</script></body>`;
    const once = ensureAssetRuntime(html, manifest);
    expect(ensureAssetRuntime(once, manifest)).toBe(once);
    expect(once.match(/type="importmap"/g)!).toHaveLength(1);
  });

  it("a three-only game still gets a map with three, and no physics bytes", () => {
    const html = `<body><script type="module">import { Scene } from "three";</script></body>`;
    const map = JSON.parse(ensureAssetRuntime(html, manifest).match(/<script type="importmap">(.*?)<\/script>/)![1]!);
    expect(map.imports.three).toContain("three.");
    expect(map.imports["cannon-es"]).toBeUndefined();
  });
});
