/**
 * The parts datum (2026-08-23, owner: "i feel the helicopter needs to have
 * skeleton to rotate the rotor and similarly the car tyres").
 *
 * The measurement that started it: 306 of 318 models carry named nodes, and 25
 * vehicles ship a node PER WHEEL. The 3D prompt had been asserting the opposite
 * — "Rigid models have NO named parts ... the only spinnable parts are ones you
 * add" — which talked every car game out of turning the wheels it already had
 * and into bolting fake ones on.
 *
 * A wheel needs no skeleton. Skinning is for a mesh that DEFORMS (a galloping
 * horse); a wheel is rigid and merely rotates, which is a node transform.
 */
import { describe, it, expect } from "vitest";
import parts from "./model-parts.json";
import manifestJson from "./manifest.json";
import type { AssetManifest } from "./manifest";

const manifest = manifestJson as AssetManifest;
const modelNames = new Set(manifest.assets.filter((a) => a.type === "model").map((a) => a.name));
const PARTS = parts as Record<string, string[]>;

describe("model-parts.json — measured, never guessed", () => {
  it("P.1 the car ships a node per wheel, plus its body", () => {
    // The owner's own example. If this ever regresses to [] the prompt's
    // wheel guidance becomes a lie again.
    expect(PARTS.car).toEqual(
      expect.arrayContaining(['body', 'wheel-front-left', 'wheel-front-right', 'wheel-back-left', 'wheel-back-right']),
    );
  });

  it("P.2 every vehicle a child asks for by name can turn its own wheels", () => {
    for (const name of ['car', 'truck', 'taxi', 'sports_car', 'race_kart', 'tractor', 'police', 'ambulance', 'firetruck']) {
      const wheels = (PARTS[name] ?? []).filter((p) => /wheel/i.test(p));
      expect(wheels.length, `${name} wheels`).toBeGreaterThanOrEqual(3);
    }
  });

  it("P.3 the helicopter now HAS a named rotor — it was rebuilt for it (2026-08-23)", () => {
    // This test asserted the opposite earlier the same day, and the flip is the
    // point: the helicopter really was one mesh called "Cube", which is why the
    // 2026-08-06 rotor incident happened. It was re-vendored from source with
    // its four primitives promoted to named nodes (vendor-models.mjs
    // splitParts) and the rotor given a hub pivot (spinParts).
    expect(PARTS.helicopter).toEqual(expect.arrayContaining(['body', 'canopy', 'rotor']));
  });

  it("P.4 the spin wrapper's internal mesh node is NEVER offered as a part", () => {
    // `rotor` is a wrapper carrying the hub pivot; `rotor_mesh` beneath it is an
    // implementation detail of surviving meshopt quantization, which rewrites a
    // MESH node's transform to its bounding-box centre. Offering the child
    // would hand a game the one node whose transform the compressor owns — and
    // spinning it reproduces the exact wobble the wrapper exists to cure.
    for (const [name, list] of Object.entries(PARTS)) {
      for (const part of list) expect(part.endsWith('_mesh'), `${name}: ${part}`).toBe(false);
    }
  });

  it("P.5 small_plane already has its propeller — so the fallback must not be blanket", () => {
    expect(PARTS.small_plane).toEqual(expect.arrayContaining(['Propeller_Cone']));
  });

  it("P.6 lockstep with the manifest — a parts entry for a model we no longer ship is stale data", () => {
    for (const name of Object.keys(PARTS)) expect(modelNames.has(name), name).toBe(true);
  });

  it("P.7 no exporter noise is offered as a part", () => {
    // "Cube", "RootNode", "Object_3" are what a exporter emits when nobody
    // named anything. Offering them would send a game hunting for a part that
    // means nothing — guessing again, under a new name.
    for (const [name, list] of Object.entries(PARTS)) {
      for (const p of list) {
        expect(/^(RootNode|Scene|Root|Cube|Circle|Sphere|Plane|Cylinder|Mesh)$/i.test(p), `${name}: ${p}`).toBe(false);
        expect(p.trim().length, `${name}: empty part name`).toBeGreaterThan(0);
      }
    }
  });

  it("P.8 every entry has at least one part — an empty list is a no-op row", () => {
    for (const [name, list] of Object.entries(PARTS)) expect(list.length, name).toBeGreaterThan(0);
  });
});
