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

describe("injectAssets — CC-BY art-credits chip (owner decision 2026-08-06)", () => {
  const withBike: AssetManifest = {
    assets: [
      entry("three", "engine", 580_000, "a"),
      entry("car", "model", 14_000, "b"),
      { ...entry("military_motorbike", "model", 90_000, "e"), license: "CC-BY-3.0" as const, author: "Zsky", sourceUrl: "https://poly.pizza/m/9SwnIlPjNv" },
    ],
  };

  it("bakes the chip (author + source link + license) into a game that uses a CC-BY model", () => {
    const r = injectAssets(
      `<html><head></head><body>${THREE_MARKER}<!--USES_MODELS: military_motorbike--><script>go()</script></body></html>`,
      withBike,
    );
    expect(r.html).toContain('id = "ar-credits"');
    expect(r.html).toContain("Zsky");
    expect(r.html).toContain("https://poly.pizza/m/9SwnIlPjNv");
    expect(r.html).toContain("CC BY 3.0");
  });

  it("adds NO chip when the game only uses CC0 models — no duty, no chrome", () => {
    const r = injectAssets(
      `<html><head></head><body>${THREE_MARKER}<!--USES_MODELS: car--><script>go()</script></body></html>`,
      withBike,
    );
    expect(r.html).not.toContain("ar-credits");
  });

  it("adds NO chip when the CC-BY model was dropped (unknown/budget) — a credit for absent art is a lie", () => {
    const r = injectAssets(
      `<html><head></head><body>${THREE_MARKER}<!--USES_MODELS: car, military_motorbike--><script>go()</script></body></html>`,
      { assets: withBike.assets.map((a) => (a.name === "military_motorbike" ? { ...a, bytes: 1_500_000 } : a)) },
    );
    expect(r.dropped).toEqual(["military_motorbike"]);
    expect(r.html).not.toContain("ar-credits");
  });
});

// BUG-FIX-LOG 2026-08-06 (bikes never appeared in the Sky Patrol helicopter
// game): on an EDIT turn the model is shown the previous artifact — which we
// store POST-injection — so its output echoes the old injected runtime back.
// injectAssets used to prepend fresh blocks without stripping the echoed
// ones; the stale window.AR_ASSETS assignment sat LATER in document order and
// overwrote the fresh table, so every model added mid-game silently vanished
// (loadModel → unknown model → null → skipped). These tests re-inject the
// injector's OWN output, the exact shape a real edit turn produces.
describe("injectAssets — edit turns strip and reclaim the previous injection", () => {
  const firstTurn = injectAssets(
    `<html><head></head><body>${THREE_MARKER}<!--USES_MODELS: car, tree--><script type="module">import "three"; loadModel(pick());</script></body></html>`,
    manifest,
  );

  function editTurn(prevHtml: string, marker: string): string {
    // What delivery sees on an edit: the echoed injected doc, with the model's
    // fresh markers re-emitted (the prompt requires markers on every turn).
    return prevHtml.replace("<body>", `<body>${THREE_MARKER}<!--USES_MODELS: ${marker}-->`);
  }

  it("re-injecting with a NEW model yields exactly one AR_ASSETS table that contains it", () => {
    const r = injectAssets(editTurn(firstTurn.html, "car, tree, dino"), manifest);
    expect(r.html.match(/window\.AR_ASSETS\s*=/g)?.length).toBe(1);
    expect(assetsTable(r.html)).toEqual({ car: urlOf("car"), tree: urlOf("tree"), dino: urlOf("dino") });
  });

  it("keeps exactly one loadModel helper and one import map", () => {
    const r = injectAssets(editTurn(firstTurn.html, "car, dino"), manifest);
    expect(r.html.match(/window\.loadModel\s*=/g)?.length).toBe(1);
    expect(r.html.match(/<script type="importmap">/g)?.length).toBe(1);
  });

  it("reclaims manifest-known models from the stale table even when the fresh marker forgets them", () => {
    // The game's code still calls loadModel("car") from turn 1; the model's
    // new marker lists only the addition. The old table is the only record —
    // its names must survive the strip, or the edit breaks the existing game.
    const r = injectAssets(editTurn(firstTurn.html, "dino"), manifest);
    const table = assetsTable(r.html);
    expect(table.car).toBe(urlOf("car"));
    expect(table.tree).toBe(urlOf("tree"));
    expect(table.dino).toBe(urlOf("dino"));
    expect(r.referencedUrls).toContain(urlOf("car"));
  });

  it("is idempotent — injecting the injector's own output changes nothing but the marker strip", () => {
    const again = injectAssets(editTurn(firstTurn.html, "car, tree"), manifest);
    expect(assetsTable(again.html)).toEqual(assetsTable(firstTurn.html));
    expect(again.html.match(/window\.AR_ASSETS\s*=/g)?.length).toBe(1);
  });
});
