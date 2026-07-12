// Audio-injection contract (PRD-3D-GAMES-AND-ASSETS §5b, §10b R2, Decision
// J): USES_AUDIO markers join the AR_ASSETS table and pull in the
// playSound/playMusic helper; audio needs NO engine (2D games get sound);
// the per-game audio budget (≤ 500 KB) and the first-load budget (≤ 2 MB)
// are enforced at inject time by dropping overflow fail-soft.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { THREE_MARKER, injectAssets } from "./inject";
import { ASSET_HOST_ORIGIN, type AssetManifest, type AssetEntry } from "./manifest";

const sha = (c: string) => c.repeat(64);
function entry(name: string, type: AssetEntry["type"], bytes: number, shaChar: string): AssetEntry {
  const ext = type === "engine" ? "js" : type === "model" ? "glb" : "mp3";
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
    entry("coin_pickup", "sfx", 11_000, "c"),
    entry("jump", "sfx", 7_000, "d"),
    entry("bg_loop_upbeat", "music", 243_000, "e"),
    entry("bg_loop_chill", "music", 229_000, "f"),
  ],
};
const urlOf = (name: string) => manifest.assets.find((a) => a.name === name)!.url;

function assetsTable(html: string): Record<string, string> {
  const m = html.match(/window\.AR_ASSETS\s*=\s*(\{[^<]*?\});/);
  if (!m) throw new Error("no AR_ASSETS table in output");
  return JSON.parse(m[1]!);
}

describe("injectAssets — USES_AUDIO", () => {
  const html = `<html><head></head><body><!--USES_AUDIO: coin_pickup, bg_loop_upbeat--><script>go()</script></body></html>`;
  const out = injectAssets(html, manifest);

  it("builds AR_ASSETS with exactly the requested audio urls", () => {
    expect(assetsTable(out.html)).toEqual({ coin_pickup: urlOf("coin_pickup"), bg_loop_upbeat: urlOf("bg_loop_upbeat") });
  });

  it("strips the marker and injects the audio helper (playSound + playMusic) once", () => {
    expect(out.html).not.toContain("USES_AUDIO");
    expect(out.html.match(/window\.playSound/g)?.length).toBe(1);
    expect(out.html.match(/window\.playMusic/g)?.length).toBe(1);
  });

  it("audio-only games get NO import map and NO loadModel — sound works in 2D", () => {
    expect(out.html).not.toContain("importmap");
    expect(out.html).not.toContain("loadModel");
  });

  it("playMusic loops via Web Audio, not <audio loop> (R2: MP3 encoder gap)", () => {
    expect(out.html).toContain("decodeAudioData");
    expect(out.html).toContain("loopStart");
    expect(out.html).not.toMatch(/new Audio\(/);
  });

  it("ledger carries the audio urls (no engine)", () => {
    expect(out.referencedUrls).toEqual([urlOf("coin_pickup"), urlOf("bg_loop_upbeat")]);
  });

  it("unknown audio names drop fail-soft", () => {
    const r = injectAssets(`<html><head></head><body><!--USES_AUDIO: jump, kazoo--></body></html>`, manifest);
    expect(assetsTable(r.html)).toEqual({ jump: urlOf("jump") });
    expect(r.dropped).toEqual(["kazoo"]);
  });

  it("audio + 3D + models compose: one AR_ASSETS table, both helpers, one import map", () => {
    const r = injectAssets(
      `<html><head></head><body>${THREE_MARKER}<!--USES_MODELS: car--><!--USES_AUDIO: jump--></body></html>`,
      manifest,
    );
    expect(assetsTable(r.html)).toEqual({ car: urlOf("car"), jump: urlOf("jump") });
    expect(r.html).toContain("importmap");
    expect(r.html).toContain("loadModel");
    expect(r.html).toContain("playSound");
    expect(r.referencedUrls).toEqual([urlOf("three"), urlOf("car"), urlOf("jump")]);
  });
});

describe("injectAssets — audio budgets (Decision J)", () => {
  it("drops audio past the 500 KB per-game audio cap, keeping later smaller ones that fit", () => {
    const r = injectAssets(
      `<html><head></head><body><!--USES_AUDIO: bg_loop_upbeat, bg_loop_chill, jump--></body></html>`,
      manifest,
    );
    // upbeat (243K) fits; chill would make 472K — fits too; jump 7K fits: total 479K OK.
    expect(Object.keys(assetsTable(r.html))).toEqual(["bg_loop_upbeat", "bg_loop_chill", "jump"]);

    const fat: AssetManifest = {
      assets: [
        ...manifest.assets,
        entry("bg_loop_tense", "music", 380_000, "9"),
      ],
    };
    const r2 = injectAssets(
      `<html><head></head><body><!--USES_AUDIO: bg_loop_upbeat, bg_loop_tense, jump--></body></html>`,
      fat,
    );
    // upbeat 243K fits; tense would hit 623K > 500K → dropped; jump still fits.
    expect(Object.keys(assetsTable(r2.html))).toEqual(["bg_loop_upbeat", "jump"]);
    expect(r2.dropped).toEqual(["bg_loop_tense"]);
  });

  it("audio counts toward the 2 MB first-load budget alongside engine + models", () => {
    const fat: AssetManifest = {
      assets: [
        entry("three", "engine", 580_000, "a"),
        { ...entry("bigmodel", "model", 100_000, "b"), bytes: 1_300_000 },
        entry("jump", "sfx", 200_000, "d"),
      ],
    };
    const r = injectAssets(
      `<html><head></head><body>${THREE_MARKER}<!--USES_MODELS: bigmodel--><!--USES_AUDIO: jump--></body></html>`,
      fat,
    );
    // 580K + 1.3M = 1.88M; jump's 200K would cross 2 MB → dropped.
    expect(r.dropped).toEqual(["jump"]);
  });
});
