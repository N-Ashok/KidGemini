// The names we ALLOW must be names the SERVED bundle actually EXPORTS.
//
// WHY THIS EXISTS: a child's "Village Turbo Racer" shipped dead. The build
// imported `CatmullRomCurve3`, which the vendored three bundle does not
// export. A missing export is a PARSE error, so the whole module never runs —
// her console read:
//
//   Uncaught SyntaxError: The requested module 'three' does not provide an
//   export named 'CatmullRomCurve3'
//   Uncaught ReferenceError: startGame is not defined
//
// The Start button did nothing.
//
// WHY IT CHECKS THE PUBLISHED LIST, NOT THE VENDOR SCRIPT (2026-08-16): the
// first version of this test compared the curated names against
// `THREE_EXPORTS` in scripts/vendor-three.mjs — the RECIPE. But the bundle
// every game loads is a content-hashed file already sitting on
// assets.ariantra.com, and editing the recipe does not change it. Adding a
// name to the recipe and teaching it in the same commit would advertise an
// export that the live bundle does not have, which is precisely the fault
// above, arriving through the tool built to prevent it.
//
// So the contract is against `three-exports.published.json`, which the vendor
// script writes at stage 4 — AFTER the upload has been verified and the
// manifest entry updated. It can only say what is genuinely being served.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_IMPORT_NAMES } from "./prompt-catalog";
import published from "./three-exports.published.json";
import manifestJson from "./manifest.json";
import type { AssetManifest } from "./manifest";

/** The names in the vendoring script's list — the RECIPE for the NEXT bundle,
 *  which is not necessarily the one being served. */
function recipeExports(): Set<string> {
  const src = readFileSync(join(process.cwd(), "scripts/vendor-three.mjs"), "utf8");
  const names = new Set<string>();
  const block = src.match(/THREE_EXPORTS\s*=\s*\[([\s\S]*?)\n\]/);
  if (block) for (const m of block[1]!.matchAll(/["'`]([A-Za-z0-9_$]+)["'`]/g)) names.add(m[1]!);
  // Names imported under an __Ar alias and re-exported further down
  // (InstancedMesh, WebGLRenderer, AnimationMixer). A first version of this
  // test missed these and reported InstancedMesh as drift — a false alarm is
  // as damaging to a safety net as a miss, because the next person learns to
  // ignore it.
  for (const m of src.matchAll(/(\w+)\s+as\s+__Ar\w+/g)) names.add(m[1]!);
  // Anything re-exported from a subpath (GLTFLoader, MeshoptDecoder).
  for (const m of src.matchAll(/export\s*\{\s*([A-Za-z0-9_$,\s]+)\s*\}/g)) {
    for (const n of m[1]!.split(",")) {
      const clean = n.trim().split(/\s+as\s+/)[0]!.trim();
      if (clean) names.add(clean);
    }
  }
  return names;
}

describe("curated imports vs the bundle that is actually SERVED", () => {
  const served = new Set(published.exports);

  it("the published export list is readable and non-trivial", () => {
    // If this fails the test below is vacuous, so assert it loudly rather than
    // silently passing on an empty set.
    expect(served.size).toBeGreaterThan(10);
  });

  it("the published list describes the bundle the manifest points at", () => {
    // The file records the URL it was written for. If the manifest moved to a
    // new bundle without the list being rewritten, every check here is stale.
    const engine = (manifestJson as AssetManifest).assets.find(
      (a) => a.type === "engine" && a.name === "three",
    );
    expect(published.url).toBe(engine?.url);
  });

  it("every name we tell the model it may import is exported by the served bundle", () => {
    const advertisedButAbsent = CURATED_IMPORT_NAMES.filter((n) => !served.has(n));
    expect(advertisedButAbsent).toEqual([]);
  });

  it("CatmullRomCurve3 is either served or NOT advertised — never advertised-only", () => {
    // The exact failure, pinned by name so it cannot come back through a
    // well-meaning addition to the curated list.
    const advertised = (CURATED_IMPORT_NAMES as readonly string[]).includes("CatmullRomCurve3");
    if (advertised) expect(served.has("CatmullRomCurve3")).toBe(true);
  });
});

describe("the vendoring recipe vs what is published", () => {
  it("anything added to the recipe but not yet published is NOT taught", () => {
    // A pending addition is fine and expected — the recipe changes first, the
    // upload follows, and only then may the name be taught. What must never
    // happen is teaching it in between. This states that ordering as a test
    // rather than as a comment somebody has to remember.
    const pending = [...recipeExports()].filter((n) => !new Set(published.exports).has(n));
    const taughtButPending = pending.filter((n) =>
      (CURATED_IMPORT_NAMES as readonly string[]).includes(n),
    );
    expect(taughtButPending).toEqual([]);
  });

  it("the recipe never DROPS a name that is currently taught", () => {
    // Removing an export from the recipe while the prompt still teaches it
    // breaks every game that takes us up on it, on the next bundle.
    const recipe = recipeExports();
    expect(CURATED_IMPORT_NAMES.filter((n) => !recipe.has(n))).toEqual([]);
  });
});
