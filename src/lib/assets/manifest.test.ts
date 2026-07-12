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

  it("rejects any license but CC0 for library assets — zero licensing risk is a goal, not a preference", () => {
    expect(() => validateEntry(entry({ license: "CC-BY" as never }))).toThrow(/license/i);
    // MIT is allowed ONLY for the engine (three.js ships its notice in-bundle)
    expect(() => validateEntry(entry({ license: "MIT" }))).toThrow(/license/i);
    expect(() =>
      validateEntry(entry({ type: "engine", url: `${ASSET_HOST_ORIGIN}/car.a3f8c2.js`, license: "MIT" })),
    ).not.toThrow();
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

describe("the committed manifest.json", () => {
  it("passes full validation (this is the standing gate on every commit)", () => {
    expect(() => validateManifest(manifest as never)).not.toThrow();
  });
});
