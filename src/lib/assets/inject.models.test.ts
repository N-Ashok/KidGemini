// Model-injection contract (PRD-3D-GAMES-AND-ASSETS §5b, §11): USES_MODELS
// markers become an AR_ASSETS url table + the loadModel helper; unknown names
// drop fail-soft; the first-load transfer budget (≤ 2 MB, Decision J) is
// enforced at inject time by dropping overflow assets — a game must never
// ship referencing more than the budget.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { THREE_MARKER, injectAssets } from "./inject";
import { ASSET_HOST_ORIGIN, type AssetManifest, type AssetEntry } from "./manifest";
import { countSizeTables } from "./runtime-helpers";

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

// 2026-08-08, BUG-FIX-LOG fragmented race tracks: the injector ships the
// measured metres alongside the URL table so modelSize() has something to read.
describe("injectAssets — the AR_SIZES table", () => {
  const sized: AssetManifest = {
    assets: [
      entry("three", "engine", 580_000, "a"),
      { ...entry("car", "model", 14_000, "b"), size: [1.3, 0.733, 2.56] },
      { ...entry("road_straight", "model", 11_000, "e"), size: [1, 0.02, 1] },
      entry("dino", "model", 83_000, "c"), // skinned upstream — ships no size
    ],
  };
  const sizesTable = (html: string) => {
    const m = html.match(/window\.AR_SIZES\s*=\s*(\{[^<]*?\});/);
    if (!m) throw new Error("no AR_SIZES table in output");
    return JSON.parse(m[1]!) as Record<string, [number, number, number]>;
  };
  const game = (models: string) =>
    `<!doctype html><html><head></head><body>${THREE_MARKER}<!--USES_MODELS: ${models}--><script type="module">go()</script></body></html>`;

  it("ships the measured metres for each model the game uses", () => {
    const out = injectAssets(game("car, road_straight"), sized).html;
    expect(sizesTable(out)).toEqual({ car: [1.3, 0.733, 2.56], road_straight: [1, 0.02, 1] });
  });

  it("omits an unmeasured model from sizes while keeping it loadable", () => {
    // A skinned model has no trustworthy bbox. It must still LOAD — only its
    // size is unknown, and modelSize() says so by answering null.
    const out = injectAssets(game("car, dino"), sized).html;
    expect(sizesTable(out)).toEqual({ car: [1.3, 0.733, 2.56] });
    expect(assetsTable(out).dino).toBe(sized.assets.find((a) => a.name === "dino")!.url);
  });

  it("emits no sizes block at all when nothing in play is measured", () => {
    const out = injectAssets(game("dino"), sized).html;
    expect(out).not.toContain("window.AR_SIZES=");
  });

  it("leaves exactly ONE sizes block when an edit turn echoes the previous injection", () => {
    // The 2026-08-06 duplicate-table class, now for the second table:
    // stripInjectedHelperBlocks does not match AR_SIZES, so the injector needs
    // its own strip or a stale block survives and runs LAST.
    const first = injectAssets(game("car, road_straight"), sized).html;
    const again = injectAssets(
      first.replace("<body>", `<body>${THREE_MARKER}<!--USES_MODELS: car, road_straight-->`),
      sized,
    ).html;
    // countSizeTables, not a bare /window\.AR_SIZES =/ count: the loadModel
    // helper carries its own `window.AR_SIZES = window.AR_SIZES || {}` guard,
    // which is not a table block and must not be counted as one (nor stripped —
    // the block regex requires the assignment to open the script tag).
    expect(countSizeTables(again)).toBe(1);
    expect(sizesTable(again)).toEqual(sizesTable(first));
  });
});

// AR_AXES end-to-end (2026-08-08, BUG-FIX-LOG "poorly formed race track").
// The declaration is worthless unless it actually reaches the running game.
describe("AR_AXES — the run axis reaches the game", () => {
  it("emits the axis table alongside AR_SIZES for the tiles in play", () => {
    const html = injectAssets(
      `<html><body><!--USES_THREE--><!--USES_MODELS: road_straight, road_curve--><script>loadModel("road_straight")</script></body></html>`,
    ).html;
    const table = JSON.parse(html.match(/window\.AR_AXES=(\{.*?\});/)![1]!);
    expect(table).toEqual({ road_straight: "x", road_curve: "none" });
    // Exactly ONE table — a stale second would win by document order, the
    // duplicate-table class from the 2026-08-06 Sky Patrol bikes bug.
    expect(html.match(/window\.AR_AXES=/g)!.length).toBe(1);
  });

  it("omits an undeclared piece entirely, so modelAxis() answers null rather than guessing", () => {
    const html = injectAssets(
      `<html><body><!--USES_THREE--><!--USES_MODELS: road_bridge--><script>loadModel("road_bridge")</script></body></html>`,
    ).html;
    expect(html).not.toContain("window.AR_AXES=");
  });

  it("ships modelAxis() itself, reading that table and rejecting anything else", () => {
    const html = injectAssets(
      `<html><body><!--USES_THREE--><!--USES_MODELS: road_straight--><script>loadModel("road_straight")</script></body></html>`,
    ).html;
    expect(html).toContain("window.modelAxis = function (name)");
    expect(html).toContain('(a === "x" || a === "z" || a === "none") ? a : null');
  });
});
