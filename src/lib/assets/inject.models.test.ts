// Model-injection contract (PRD-3D-GAMES-AND-ASSETS §5b, §11): USES_MODELS
// markers become an AR_ASSETS url table + the loadModel helper; unknown names
// drop fail-soft; the first-load transfer budget (≤ 2 MB, Decision J) is
// enforced at inject time by dropping overflow assets — a game must never
// ship referencing more than the budget.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { THREE_MARKER, injectAssets } from "./inject";
import { ASSET_HOST_ORIGIN, type AssetManifest, type AssetEntry } from "./manifest";

const sha = (c: string) => c.repeat(64);
function entry(name: string, type: AssetEntry["type"], bytes: number, shaChar: string): AssetEntry {
  const ext = type === "engine" ? "js" : "glb";
  return {
    name, type, bytes,
    url: `${ASSET_HOST_ORIGIN}/${name}.${sha(shaChar).slice(0, 6)}.${ext}`,
    license: type === "engine" ? "MIT" : "CC0",
    sourceUrl: "https://example.com/proof",
    sha256: sha(shaChar),
  };
}

const manifest: AssetManifest = {
  assets: [
    entry("three", "engine", 580_000, "a"),
    entry("car", "model", 14_000, "b"),
    entry("dino", "model", 83_000, "c"),
    entry("tree", "model", 7_000, "d"),
  ],
};
const urlOf = (name: string) => manifest.assets.find((a) => a.name === name)!.url;

function assetsTable(html: string): Record<string, string> {
  const m = html.match(/window\.AR_ASSETS\s*=\s*(\{[^<]*?\});/);
  if (!m) throw new Error("no AR_ASSETS table in output");
  return JSON.parse(m[1]!);
}

describe("injectAssets — USES_MODELS", () => {
  const html = `<!doctype html><html><head></head><body>${THREE_MARKER}<!--USES_MODELS: car, tree--><script type="module">go()</script></body></html>`;
  const out = injectAssets(html, manifest);

  it("builds AR_ASSETS with exactly the requested model urls", () => {
    expect(assetsTable(out.html)).toEqual({ car: urlOf("car"), tree: urlOf("tree") });
  });

  it("strips the models marker and includes the loadModel helper once", () => {
    expect(out.html).not.toContain("USES_MODELS");
    expect(out.html.match(/window\.loadModel/g)?.length).toBe(1);
  });

  it("wires the meshopt decoder into GLTFLoader (models are gltfpack -cc)", () => {
    expect(out.html).toContain("GLTFLoader");
    expect(out.html).toContain("MeshoptDecoder");
    expect(out.html).toContain("setMeshoptDecoder");
  });

  it("ledger carries the engine AND every model url", () => {
    expect(out.referencedUrls).toEqual([urlOf("three"), urlOf("car"), urlOf("tree")]);
  });

  it("drops unknown names fail-soft (no url table entry, game unharmed)", () => {
    const r = injectAssets(
      `<html><head></head><body>${THREE_MARKER}<!--USES_MODELS: car, unicorn--><script>go()</script></body></html>`,
      manifest,
    );
    expect(assetsTable(r.html)).toEqual({ car: urlOf("car") });
    expect(r.dropped).toEqual(["unicorn"]);
  });

  it("USES_MODELS without USES_THREE still injects the import map — loadModel needs the engine", () => {
    const r = injectAssets(
      `<html><head></head><body><!--USES_MODELS: car--><script>go()</script></body></html>`,
      manifest,
    );
    expect(r.html).toContain('<script type="importmap">');
    expect(r.html).toContain(urlOf("three"));
    expect(r.referencedUrls).toContain(urlOf("car"));
  });

  it("a game with no markers at all stays byte-identical", () => {
    const plain = "<html><head></head><body>2d</body></html>";
    expect(injectAssets(plain, manifest).html).toBe(plain);
  });
});

describe("injectAssets — first-load transfer budget (≤ 2 MB, inject-time)", () => {
  it("drops assets from the END once the engine+models sum would cross 2 MB", () => {
    const fat: AssetManifest = {
      assets: [
        entry("three", "engine", 580_000, "a"),
        entry("car", "model", 100_000, "b"),
        { ...entry("dino", "model", 100_000, "c"), bytes: 1_400_000 }, // pushes past 2 MB
        entry("tree", "model", 7_000, "d"),
      ],
    };
    const r = injectAssets(
      `<html><head></head><body>${THREE_MARKER}<!--USES_MODELS: car, dino, tree--><script>go()</script></body></html>`,
      fat,
    );
    // car fits (680K), dino would blow the cap (2.08M) → dropped; tree still fits.
    expect(Object.keys(assetsTable(r.html))).toEqual(["car", "tree"]);
    expect(r.dropped).toEqual(["dino"]);
  });
});
