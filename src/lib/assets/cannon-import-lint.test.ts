// The lockstep that keeps a physics game from dying on its import line
// (2026-07-29). Three lists must agree: what the bundle EXPORTS
// (scripts/vendor-cannon.mjs), what the lint ALLOWS, and what the prompt
// TEACHES. Any drift between them is a game that never runs.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { CANNON_IMPORT_NAMES, unknownCannonImports, newUnknownCannonImports } from "./cannon-import-lint";
import { physicsEnginePromptSection } from "./physics-playbook";
import { ASSET_HOST_ORIGIN, type AssetManifest } from "./manifest";

// The clause is manifest-gated, so teach-check it against a manifest that HAS
// the engine — otherwise this test would silently pass on an empty string.
const withCannon: AssetManifest = {
  assets: [{
    name: "physics", type: "engine", bytes: 92_000,
    url: `${ASSET_HOST_ORIGIN}/physics.${"c".repeat(6)}.js`,
    license: "MIT", sourceUrl: "https://example.com", sha256: "c".repeat(64),
  }],
};

describe("lockstep with the vendored bundle", () => {
  it("allows exactly the names scripts/vendor-cannon.mjs exports (scrape, not a copy)", () => {
    const src = readFileSync(join(__dirname, "../../../scripts/vendor-cannon.mjs"), "utf8");
    const list = src.match(/export const CANNON_EXPORTS = \[([\s\S]*?)\];/);
    expect(list).not.toBeNull();
    const exported = [...list![1]!.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]!);
    expect([...exported].sort()).toEqual([...CANNON_IMPORT_NAMES].sort());
  });

  it("teaches every allowed name in the prompt, so the model knows what exists", () => {
    // A name the bundle exports but the prompt never mentions is dead weight;
    // a name the prompt teaches but the bundle lacks is a crashed game.
    const clause = physicsEnginePromptSection(withCannon);
    expect(clause).not.toBe("");
    for (const name of CANNON_IMPORT_NAMES) {
      expect(clause, `physics clause must teach "${name}"`).toContain(name);
    }
  });
});

describe("the engine clause is gated on the engine existing", () => {
  it("renders NOTHING when the manifest has no cannon entry (never teach a dead import)", () => {
    expect(physicsEnginePromptSection({ assets: [] })).toBe("");
  });

  it("teaches the marker the injector actually looks for", () => {
    expect(physicsEnginePromptSection(withCannon)).toContain("<!--USES_PHYSICS-->");
  });

  it("tells the model NOT to reach for the engine on ordinary games", () => {
    // The expensive failure mode is a platformer wired through rigid bodies:
    // 92 KB heavier, jitterier, and worse-feeling than the playbook maths.
    expect(physicsEnginePromptSection(withCannon)).toMatch(/Do NOT use it for/i);
  });
});

describe("unknownCannonImports", () => {
  it("passes a game importing only curated names", () => {
    const html = `<script type="module">import { World, Body, Vec3, Box } from "cannon-es";</script>`;
    expect(unknownCannonImports(html)).toEqual([]);
  });

  it("flags a name the bundle does not export (the crash case)", () => {
    // ConvexPolyhedron and Trimesh are real cannon-es names we deliberately did
    // NOT vendor — the model reaching for them is the exact "DoubleSide"
    // incident replayed on the physics bundle.
    const html = `<script type="module">import { World, ConvexPolyhedron } from "cannon-es";</script>`;
    expect(unknownCannonImports(html)).toEqual(["ConvexPolyhedron"]);
  });

  it("reports the ORIGINAL name, not the local alias", () => {
    const html = `<script type="module">import { Trimesh as Mesh } from "cannon-es";</script>`;
    expect(unknownCannonImports(html)).toEqual(["Trimesh"]);
  });

  it("ignores namespace imports — they cannot crash the import line", () => {
    const html = `<script type="module">import * as CANNON from "cannon-es";</script>`;
    expect(unknownCannonImports(html)).toEqual([]);
  });

  it("does not confuse three imports for cannon ones", () => {
    const html = `<script type="module">import { Scene } from "three";</script>`;
    expect(unknownCannonImports(html)).toEqual([]);
  });

  it("dedupes a name imported twice", () => {
    const html = `<script>import { Spring } from "cannon-es";</script><script>import { Spring } from "cannon-es";</script>`;
    expect(unknownCannonImports(html)).toEqual(["Spring"]);
  });
});

describe("newUnknownCannonImports — an edit is judged only on what it ADDED", () => {
  it("ignores a violation that was already in the source", () => {
    const before = `import { Spring } from "cannon-es";`;
    expect(newUnknownCannonImports(before, before)).toEqual([]);
  });

  it("catches one the patch introduced", () => {
    const before = `import { World } from "cannon-es";`;
    const after = `import { World, Trimesh } from "cannon-es";`;
    expect(newUnknownCannonImports(before, after)).toEqual(["Trimesh"]);
  });
});
