// The injected frame governor (2026-07-29). Owner report: "my system got
// heated up" after ~1h playing in the preview, then: "once it is made, edits
// don't need to touch it?" — which is right, and is the whole reason this
// exists. An edit is a minimal SEARCH/REPLACE patch, so the playbook's
// pause/cap rules only ever reach NEW games. ensureAssetRuntime runs on every
// preview render of every game, including ones whose stored HTML long predates
// this change, so the governor is the only thing that reaches games that
// already exist.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ensureAssetRuntime } from "./ensure-runtime";
import { ASSET_HOST_ORIGIN, type AssetManifest } from "./manifest";

const manifest: AssetManifest = {
  assets: [{
    name: "three", type: "engine", bytes: 619_000,
    url: `${ASSET_HOST_ORIGIN}/three.${"a".repeat(6)}.js`,
    license: "MIT", sourceUrl: "https://example.com", sha256: "a".repeat(64),
  }],
};
const game = (body: string) => `<body><script type="module">${body}</script></body>`;

describe("frame governor — reaches games that already exist", () => {
  const out = ensureAssetRuntime(game(`import { Scene } from "three"; requestAnimationFrame(loop);`), manifest);

  it("is injected into an old 3D game with no pause logic of its own", () => {
    expect(out).toMatch(/__arFrameGovernor/);
  });

  it("caps to ~60fps by skipping frames closer together than 15ms", () => {
    expect(out).toMatch(/15/);
    expect(out).toMatch(/requestAnimationFrame/);
  });

  it("skips work while the page is hidden", () => {
    expect(out).toMatch(/document\.hidden/);
  });

  it("is idempotent — a second pass adds no second governor", () => {
    // Count the ASSIGNMENT, not the name: one governor mentions
    // __arFrameGovernor twice (guard read + guard set), so counting the name
    // would make a single injection look like two.
    const twice = ensureAssetRuntime(out, manifest);
    expect(out.match(/__arFrameGovernor = 1/g) ?? []).toHaveLength(1);
    expect(twice.match(/__arFrameGovernor = 1/g) ?? []).toHaveLength(1);
  });

  it("leaves a plain 2D game completely untouched (identity)", () => {
    // ensureAssetRuntime early-returns for non-3D games; the governor must not
    // change that contract or it becomes a blast radius over every 2D game.
    const flat = `<body><canvas></canvas><script>requestAnimationFrame(t);</script></body>`;
    expect(ensureAssetRuntime(flat, manifest)).toBe(flat);
  });
});

describe("frame governor — the safety properties that let it ship to old games", () => {
  const out = ensureAssetRuntime(game(`import { Scene } from "three";`), manifest);

  it("keeps the animation chain alive when it skips (never silently kills a game)", () => {
    // A governor that returns without re-requesting stops the game dead. This
    // is the single most dangerous way to get this wrong.
    const gov = out.match(/__arFrameGovernor[\s\S]*?<\/script>/)?.[0] ?? "";
    // Both skip paths (hidden, and too-soon) must re-enter the wrapper.
    const skipPaths = gov.match(/window\.requestAnimationFrame\(cb\);\s*return;/g) ?? [];
    expect(skipPaths).toHaveLength(2);
  });

  it("throttles per-callback, so a game with two independent loops keeps both", () => {
    // A single shared `last` would let the first loop win every frame and
    // starve the second one completely.
    expect(out).toMatch(/WeakMap/);
  });

  it("falls back to NOT throttling when it cannot identify the callback", () => {
    // A game passing a fresh arrow each frame can't be keyed; the safe failure
    // is "no throttle", never "no frames".
    expect(out).toMatch(/\|\|\s*0/);
  });
});
