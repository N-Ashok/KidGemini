// Contract tests for the shared immutable asset host's in-repo manifest
// (PRD-3D-GAMES-AND-ASSETS §4.4, §11). The manifest is the ONLY thing the box
// (and the injector, Phase B) knows about the asset host, so every entry is
// attacked here: budgets, naming, license, hash discipline. The real
// manifest.json is validated last — a bad commit fails the suite.

import { describe, it, expect } from "vitest";
import {
  ASSET_HOST_ORIGIN,
  BUDGET_BYTES,
  hashedFileName,
  assetUrl,
  validateEntry,
  validateManifest,
  sniffMagicBytes,
  type AssetEntry,
  type AssetManifest,
} from "./manifest";
import manifest from "./manifest.json";

const SHA = "a3f8c2".padEnd(64, "0"); // valid 64-hex whose 6-char prefix is a3f8c2

function entry(overrides: Partial<AssetEntry> = {}): AssetEntry {
  return {
    name: "car",
    type: "model",
    url: `${ASSET_HOST_ORIGIN}/car.a3f8c2.glb`,
    bytes: 42_000,
    license: "CC0",
    sourceUrl: "https://kenney.nl/assets/car-kit",
    sha256: SHA,
    ...overrides,
  };
}

// Regression, 2026-07-29 (docs/BUG-FIX-LOG.md same date): scripts/vendor-cannon.mjs
// keyed its manifest entry as `name: 'cannon'` and upserted with
// `findIndex(a => a.name === 'cannon')`. The military batch ships a MODEL called
// `cannon` (the wheeled artillery piece), so the engine row REPLACED the model —
// the model vanished from the manifest while its GLB sat fine on the host. The
// engine is now named `physics` and every vendor upsert is name+type qualified,
// but the durable guard is this invariant: asset names are unique ACROSS types.
// Without it, any future `vendor-*.mjs` can silently delete an asset again.
describe("asset names are unique across the whole manifest (regression: 2026-07-29 cannon collision)", () => {
  it("no two assets share a name, whatever their type", () => {
    const byName = new Map<string, string[]>();
    for (const a of (manifest as AssetManifest).assets) {
      byName.set(a.name, [...(byName.get(a.name) ?? []), a.type]);
    }
    const collisions = [...byName.entries()].filter(([, types]) => types.length > 1);
    expect(collisions).toEqual([]);
  });

  it("the physics engine does NOT reuse the cannon model's name", () => {
    const assets = (manifest as AssetManifest).assets;
    expect(assets.find((a) => a.name === "cannon")?.type).toBe("model");
    expect(assets.find((a) => a.type === "engine" && a.name === "physics")).toBeDefined();
  });
});

describe("hashedFileName / assetUrl — the name IS the immutability mechanism", () => {
  it("names a file {name}.{sha256 first 6}.{ext}", () => {
    expect(hashedFileName("car", "glb", SHA)).toBe("car.a3f8c2.glb");
    expect(assetUrl("car.a3f8c2.glb")).toBe("https://assets.ariantra.com/car.a3f8c2.glb");
  });

  it("refuses a name that is not lowercase-snake (it becomes a public URL and a catalog token)", () => {
    expect(() => hashedFileName("Car Model!", "glb", SHA)).toThrow(/name/i);
    expect(() => hashedFileName("", "glb", SHA)).toThrow(/name/i);
  });

  it("refuses a malformed sha256", () => {
    expect(() => hashedFileName("car", "glb", "nothex")).toThrow(/sha256/i);
  });
});

describe("validateEntry — every field is load-bearing", () => {
  it("accepts a well-formed entry", () => {
    expect(() => validateEntry(entry())).not.toThrow();
  });

  it.each([
    ["model over 100 KB", entry({ bytes: BUDGET_BYTES.model + 1 })],
    ["sfx over 30 KB", entry({ type: "sfx", url: `${ASSET_HOST_ORIGIN}/car.a3f8c2.mp3`, bytes: BUDGET_BYTES.sfx + 1 })],
    ["music over 400 KB", entry({ type: "music", url: `${ASSET_HOST_ORIGIN}/car.a3f8c2.mp3`, bytes: BUDGET_BYTES.music + 1 })],
    ["engine over 600 KB", entry({ type: "engine", url: `${ASSET_HOST_ORIGIN}/car.a3f8c2.js`, bytes: BUDGET_BYTES.engine + 1 })],
    ["zero bytes", entry({ bytes: 0 })],
  ])("rejects %s (budgets are download budgets — PRD §8)", (_label, bad) => {
    expect(() => validateEntry(bad)).toThrow(/bytes|budget/i);
  });

  it("rejects unknown licenses for library assets", () => {
    expect(() => validateEntry(entry({ license: "GPL" as never }))).toThrow(/license/i);
    // MIT is allowed ONLY for the engine (three.js ships its notice in-bundle)
    expect(() => validateEntry(entry({ license: "MIT" }))).toThrow(/license/i);
    expect(() =>
      validateEntry(entry({ type: "engine", url: `${ASSET_HOST_ORIGIN}/car.a3f8c2.js`, license: "MIT" })),
    ).not.toThrow();
  });

  // Owner decision 2026-08-06 (motorcycle batch): CC-BY 3.0 models are allowed
  // WITH attribution wired in — `author` is the machine-checked half of that
  // promise (inject.ts renders the credits chip from it; a CC-BY entry without
  // an author would publish games whose credit line has no name to show).
  it("accepts a CC-BY-3.0 MODEL only when it carries its author", () => {
    expect(() =>
      validateEntry(entry({ license: "CC-BY-3.0", author: "Zsky", sourceUrl: "https://poly.pizza/m/9SwnIlPjNv" })),
    ).not.toThrow();
    expect(() => validateEntry(entry({ license: "CC-BY-3.0" }))).toThrow(/author/i);
    expect(() => validateEntry(entry({ license: "CC-BY-3.0", author: "  " }))).toThrow(/author/i);
  });

  it("keeps sfx/music CC0-only — the credits chip is a MODEL mechanism", () => {
    expect(() =>
      validateEntry(
        entry({ type: "sfx", url: `${ASSET_HOST_ORIGIN}/car.a3f8c2.mp3`, bytes: 9_000, license: "CC-BY-3.0", author: "x" }),
      ),
    ).toThrow(/license/i);
  });

  it("rejects a URL off the asset host (the contract forbids third-party references)", () => {
    expect(() => validateEntry(entry({ url: "https://cdn.example.com/car.a3f8c2.glb" }))).toThrow(/url/i);
  });

  it("rejects a filename whose hash fragment does not match the entry sha256 (changed bytes = new name)", () => {
    expect(() => validateEntry(entry({ url: `${ASSET_HOST_ORIGIN}/car.deadbe.glb` }))).toThrow(/hash/i);
  });

  it("rejects a filename whose base name does not match the entry name", () => {
    expect(() => validateEntry(entry({ url: `${ASSET_HOST_ORIGIN}/dino.a3f8c2.glb` }))).toThrow(/name/i);
  });

  it("rejects the wrong extension for the type (model=glb, sfx/music=mp3, engine=js)", () => {
    expect(() => validateEntry(entry({ url: `${ASSET_HOST_ORIGIN}/car.a3f8c2.mp3` }))).toThrow(/ext/i);
  });

  it("rejects a missing/non-https sourceUrl — the license proof must be traceable", () => {
    expect(() => validateEntry(entry({ sourceUrl: "" }))).toThrow(/source/i);
    expect(() => validateEntry(entry({ sourceUrl: "ftp://x" }))).toThrow(/source/i);
  });

  it("rejects a malformed sha256", () => {
    expect(() => validateEntry(entry({ sha256: "abc" }))).toThrow(/sha256/i);
  });
});

// The catalog is about to grow ~106 → ~300, and a name is the ONLY thing the LLM
// and the gallery can reason about — it is baked into the immutable URL, so it
// can never be corrected later. This rule keeps every new name self-describing
// instead of a numbered duplicate.
describe("validateEntry — the naming convention is machine-enforced", () => {
  it.each([["tree_2"], ["building_7"], ["character_12"]])(
    "rejects the numbered-duplicate name %s — it carries no retrieval signal",
    (name) => {
      expect(() => validateEntry(entry({ name, url: `${ASSET_HOST_ORIGIN}/${name}.a3f8c2.glb` }))).toThrow(
        /name|suffix/i,
      );
    },
  );

  it.each([["oak_tree"], ["fire_truck"], ["corner_shop"], ["bg_loop_upbeat"]])(
    "accepts the descriptive name %s ({specific}_{category})",
    (name) => {
      expect(() => validateEntry(entry({ name, url: `${ASSET_HOST_ORIGIN}/${name}.a3f8c2.glb` }))).not.toThrow();
    },
  );
});

describe("validateManifest — cross-entry rules", () => {
  it("rejects duplicate names (catalog names must be unambiguous for the model)", () => {
    expect(() => validateManifest({ assets: [entry(), entry()] })).toThrow(/duplicate/i);
  });

  it("accepts an empty manifest (Phase A starts empty until the first verified upload)", () => {
    expect(() => validateManifest({ assets: [] })).not.toThrow();
  });
});

describe("sniffMagicBytes — the pipeline verifies files are what they claim (PRD §11)", () => {
  it("recognises a GLB header", () => {
    const glb = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]);
    expect(sniffMagicBytes(glb, "model")).toBe(true);
    expect(sniffMagicBytes(Buffer.from("<html>not a model"), "model")).toBe(false);
  });

  it("recognises MP3 (ID3 tag or bare frame sync)", () => {
    expect(sniffMagicBytes(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(16)]), "sfx")).toBe(true);
    expect(sniffMagicBytes(Buffer.from([0xff, 0xfb, 0x90, 0x00]), "music")).toBe(true);
    expect(sniffMagicBytes(Buffer.from("RIFFwav-not-mp3"), "sfx")).toBe(false);
  });

  it("requires an engine bundle to be non-trivial ES module text", () => {
    expect(sniffMagicBytes(Buffer.from("export{A as Scene};//..."), "engine")).toBe(true);
    expect(sniffMagicBytes(Buffer.alloc(0), "engine")).toBe(false);
  });
});

// Regression, 2026-08-08 (docs/BUG-FIX-LOG.md same date — fragmented race
// tracks): `road_straight` is a 1 m tile and a generated racer laid 14 of them
// at 10 m intervals, so 99% of the "track" was grass. The cause was that NO
// dimension data existed anywhere the model could reach it — the manifest had
// no size field, the prompt catalog rendered bare names, and loadModel exposed
// no bounding box. `size` is the storage half of the fix: measured metres of
// the PUBLISHED bytes, shipped to the game as window.AR_SIZES.
describe("validateEntry — size is measured metres, never a guess", () => {
  it("accepts a model carrying its measured [x, y, z] metres", () => {
    expect(() => validateEntry(entry({ size: [1, 0.02, 1] }))).not.toThrow();
  });

  it("accepts a model with no size (skinned models are deliberately omitted)", () => {
    expect(() => validateEntry(entry())).not.toThrow();
  });

  it("rejects a size on anything that is not a model", () => {
    // Only models are placed in a 3D scene; a size on a sound is a pipeline bug.
    expect(() =>
      validateEntry(
        entry({
          name: "coin_pickup",
          type: "sfx",
          url: `${ASSET_HOST_ORIGIN}/coin_pickup.a3f8c2.mp3`,
          bytes: 9_000,
          size: [1, 1, 1],
        }),
      ),
    ).toThrow(/only models carry a size/);
  });

  it("rejects a size that is not a 3-tuple", () => {
    expect(() => validateEntry(entry({ size: [1, 1] as never }))).toThrow(/\[x, y, z\]/);
    expect(() => validateEntry(entry({ size: [1, 1, 1, 1] as never }))).toThrow(/\[x, y, z\]/);
    expect(() => validateEntry(entry({ size: 1 as never }))).toThrow(/\[x, y, z\]/);
  });

  it("rejects a non-positive or non-finite axis", () => {
    // A zero axis would make `i * modelSize(n).z` stack every tile on the
    // origin — silently, which is worse than the bug being fixed.
    expect(() => validateEntry(entry({ size: [0, 1, 1] }))).toThrow(/positive finite metres/);
    expect(() => validateEntry(entry({ size: [1, -1, 1] }))).toThrow(/positive finite metres/);
    expect(() => validateEntry(entry({ size: [1, NaN, 1] }))).toThrow(/positive finite metres/);
    expect(() => validateEntry(entry({ size: [1, 1, Infinity] }))).toThrow(/positive finite metres/);
  });

  it("rejects an absurd axis — the un-normalized author-scale typo guard", () => {
    // The largest real entry is suspension_bridge at 50 m. A 1e7 value means a
    // poly.pizza source slipped through without normalizeLongest.
    expect(() => validateEntry(entry({ size: [1, 1, 1e7] }))).toThrow(/under 1000/);
  });
});

describe("the committed manifest.json", () => {
  it("passes full validation (this is the standing gate on every commit)", () => {
    expect(() => validateManifest(manifest as never)).not.toThrow();
  });

  // THE headline regression for the 2026-08-08 fragmented-track bug: a tile a
  // game cannot measure is a tile it will scatter. Every road/track piece must
  // ship its footprint, or `modelSize()` returns null and the model is back to
  // guessing 10 m for a 1 m tile.
  it("ships a measured size for every road/track tile", () => {
    const tiles = (manifest as AssetManifest).assets.filter(
      (a) => a.type === "model" && /^(road|race_track)_/.test(a.name),
    );
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.filter((t) => !t.size).map((t) => t.name)).toEqual([]);
  });

  // The city road kit is the MODULAR one — measured 2026-08-08: 1 m straight/
  // intersection/crossing/ramp/bridge, 2 m curve, 3 m roundabout, all exact
  // multiples of a 1 m module and all centre-origin. That is what makes a
  // stepped layout close into a loop, so it is pinned.
  //
  // Deliberately NOT asserted for race_track_*: Kenney's racing kit is a
  // place-by-eye pair, and race_track_curve is a genuinely non-modular
  // 1.5 × 2.0 m sweep. No uniform scale puts both of its axes on whole metres
  // (×2 gives 3 × 4), and forcing one would distort the turn against the 1 × 1
  // straight. Its real size ships instead, and the prompt rule tells games to
  // step the measured footprint rather than assume a grid.
  it("keeps the city road kit on a whole-metre module", () => {
    const roads = (manifest as AssetManifest).assets.filter(
      (a) => a.type === "model" && /^road_(straight|curve|intersection|crossing|roundabout|ramp|bridge)$/.test(a.name),
    );
    expect(roads.length).toBe(7);
    const offGrid = roads.flatMap((t) => {
      const [x, , z] = t.size!;
      // X and Z only: a tile's HEIGHT (kerb, guardrail) never lands on the grid.
      return ([["x", x], ["z", z]] as const)
        .filter(([, v]) => Math.abs(v - Math.round(v)) > 0.01)
        .map(([axis, v]) => `${t.name}: ${axis} = ${v} m is not a whole-metre module`);
    });
    expect(offGrid).toEqual([]);
  });
});

// pathAxis (2026-08-08, BUG-FIX-LOG "poorly formed race track"). The two road
// kits run along DIFFERENT axes and a 1×1 m square tile's `size` cannot reveal
// which — so the model guessed, and got it wrong every time. These pin the
// declarations that now tell it.
describe("the committed manifest.json — path-piece orientation", () => {
  const byName = (n: string) =>
    (manifest as AssetManifest).assets.find((a) => a.name === n && a.type === "model");

  it("declares the CITY kit running along X and the RACING kit along Z — the disagreement that caused the bug", () => {
    expect(byName("road_straight")?.pathAxis).toBe("x");
    expect(byName("race_track_straight")?.pathAxis).toBe("z");
  });

  it("marks hubs and corners 'none' — a real answer, not a missing one", () => {
    // race_track_curve was in this list until 2026-08-09 and has been removed:
    // it is not a corner. The top-down render measured its road entering the
    // north edge and leaving the south — a chicane, which DOES have a run axis
    // (z). 'none' had been declared on the belief that it was a turn. See the
    // sibling test below.
    for (const n of ["road_curve", "road_intersection", "road_roundabout"]) {
      expect(byName(n)?.pathAxis, n).toBe("none");
    }
  });

  it("declares road_bridge 'z' — the render settled what two geometric probes could not", () => {
    // Undeclared from 2026-08-08 (TECH_DEBT #93) because extrusion-uniformity
    // and kerb-run probes disagreed. Both were reading the MESH, and a road is
    // painted into the colormap — the mesh is a rectangle whichever way the
    // road runs. Rendered top-down on 2026-08-09 its centre line is plainly
    // north-south, so it runs Z, alone among the city pieces (every other
    // road_* runs X). Until this was published, any game mixing road_bridge
    // with road_straight laid the bridge crosswise.
    expect(byName("road_bridge")?.pathAxis).toBe("z");

    // The declaration must keep agreeing with the measurement it came from.
    expect(byName("road_bridge")?.joins).toEqual(["-z", "+z"]);
  });

  it("never declares an axis on a non-path model (a car has a facing, not a run axis)", () => {
    for (const n of ["sedan", "tree", "dino"]) {
      expect(byName(n)?.pathAxis, n).toBeUndefined();
    }
  });

  // The gap that let race_track_curve's 1.5 m width through: the module test
  // above matches ONLY /^road_/, so the racing kit was never checked. A curve
  // that isn't on the module can never tile against its own 1×1 straight.
  it("flags the racing kit as OFF the whole-metre module (known, TECH_DEBT — pinned so it can't regress silently)", () => {
    const curve = byName("race_track_curve")!;
    const [x, , z] = curve.size!;
    const offGrid = [x, z].filter((v) => Math.abs(v - Math.round(v)) > 0.01);
    // race_track_curve is 1.5 × 2 — the 1.5 is the defect. Asserting it
    // EXPLICITLY means the day someone re-vendors the kit on-module, this test
    // fails and forces the manifest + this expectation to be updated together.
    expect(offGrid).toEqual([1.5]);
  });
});
