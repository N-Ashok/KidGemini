// Gallery card data (PRD-3D-GAMES-AND-ASSETS §9b): rendered straight from the
// manifest — a new manifest entry must become a card with a teachable trigger
// phrase (the free tier's keyword tutorial, §9c) with zero page work.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { galleryCards, cardEmoji } from "./gallery";
import { ASSET_HOST_ORIGIN, type AssetManifest } from "./manifest";

const sha = (c: string) => c.repeat(64);
const manifest: AssetManifest = {
  assets: [
    { name: "three", type: "engine", url: `${ASSET_HOST_ORIGIN}/three.${sha("a").slice(0, 6)}.js`, bytes: 580_000, license: "MIT", sourceUrl: "https://example.com", sha256: sha("a") },
    { name: "dino", type: "model", url: `${ASSET_HOST_ORIGIN}/dino.${sha("b").slice(0, 6)}.glb`, bytes: 83_000, license: "CC0", sourceUrl: "https://example.com", sha256: sha("b") },
    { name: "coin_pickup", type: "sfx", url: `${ASSET_HOST_ORIGIN}/coin_pickup.${sha("c").slice(0, 6)}.mp3`, bytes: 20_000, license: "CC0", sourceUrl: "https://example.com", sha256: sha("c") },
    { name: "bg_loop_upbeat", type: "music", url: `${ASSET_HOST_ORIGIN}/bg_loop_upbeat.${sha("d").slice(0, 6)}.mp3`, bytes: 200_000, license: "CC0", sourceUrl: "https://example.com", sha256: sha("d") },
  ],
};

describe("galleryCards — manifest → kid-facing cards", () => {
  const { models, sounds } = galleryCards(manifest);

  it("models become turntable cards; the engine is NOT a card", () => {
    expect(models.map((c) => c.name)).toEqual(["dino"]);
    expect(models[0]!.url).toContain("dino.");
  });

  it("every model card teaches a trigger phrase containing the '3d' keyword", () => {
    for (const c of models) {
      expect(c.trigger.toLowerCase()).toContain("3d");
      expect(c.trigger.toLowerCase()).toContain(c.name);
    }
  });

  it("sfx and music become sound cards teaching the sound keyword", () => {
    expect(sounds.map((c) => c.name)).toEqual(["coin_pickup", "bg_loop_upbeat"]);
    for (const c of sounds) expect(c.trigger.toLowerCase()).toMatch(/sound|music/);
  });

  it("display names are kid-readable (underscores → spaces, capitalized)", () => {
    expect(sounds[0]!.displayName).toBe("Coin pickup");
    expect(models[0]!.displayName).toBe("Dino");
  });

  it("empty manifest → empty card lists (page shows its friendly empty state)", () => {
    const empty = galleryCards({ assets: [] });
    expect(empty.models).toEqual([]);
    expect(empty.sounds).toEqual([]);
  });
});

describe("cardEmoji — every card has a face even for unknown names", () => {
  it("maps known names and falls back for unknown ones", () => {
    expect(cardEmoji("dino")).toBe("🦖");
    expect(cardEmoji("rocket")).toBe("🚀");
    expect(cardEmoji("something_new")).toBeTruthy();
  });

  it("every curated model in vendor-models.mjs has its OWN emoji, not the fallback (lockstep scrape)", () => {
    const vendorSource = readFileSync(join(__dirname, "../../../scripts/vendor-models.mjs"), "utf8");
    const names = [...vendorSource.matchAll(/name: '([a-z0-9_]+)',/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThanOrEqual(50);
    for (const name of names) {
      expect(cardEmoji(name), `gallery emoji missing for curated model "${name}"`).not.toBe("🧸");
    }
  });
});

describe("trigger phrases — grammar edge cases", () => {
  it("uncountable names don't get a bolted-on s (\"3d police\", never \"3d polices\")", () => {
    const m: AssetManifest = { assets: [{ name: "police", type: "model", url: `${ASSET_HOST_ORIGIN}/police.${sha("e").slice(0, 6)}.glb`, bytes: 40_000, license: "CC0", sourceUrl: "https://example.com", sha256: sha("e") }] };
    expect(galleryCards(m).models[0]!.trigger).toBe("3d police");
  });

  it("people pluralize like people (\"3d men\" / \"3d women\", never \"3d mans\") (2026-07-19)", () => {
    const entry = (name: string) => ({ name, type: "model" as const, url: `${ASSET_HOST_ORIGIN}/${name}.${sha("f").slice(0, 6)}.glb`, bytes: 60_000, license: "CC0" as const, sourceUrl: "https://example.com", sha256: sha("f") });
    const m: AssetManifest = { assets: [entry("man"), entry("woman")] };
    expect(galleryCards(m).models.map((c) => c.trigger)).toEqual(["3d men", "3d women"]);
  });
});
