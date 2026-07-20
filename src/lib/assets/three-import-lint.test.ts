// Deterministic three-import lint (BUG-FIX-LOG 2026-07-20 "DoubleSide"): a
// generated game importing a name the vendored bundle doesn't export dies on
// its import line — the whole game script never runs. The lint catches the
// violation server-side, BEFORE the kid ever sees a dead game.
import { describe, it, expect } from "vitest";
import { newUnknownThreeImports, unknownThreeImports } from "./three-import-lint";

const game = (imports: string) =>
  `<html><body><script type="module">import { ${imports} } from "three";\nconst x = 1;</script></body></html>`;

describe("unknownThreeImports", () => {
  it("flags names the bundle does not export (the DoubleSide incident, pre-growth)", () => {
    // TubeGeometry / OrbitControls are NOT vendored — classic model drift.
    expect(unknownThreeImports(game("Scene, TubeGeometry"))).toEqual(["TubeGeometry"]);
    expect(unknownThreeImports(game("OrbitControls"))).toEqual(["OrbitControls"]);
  });

  it("passes every curated name, plus the loader module's own imports", () => {
    expect(unknownThreeImports(game("Scene, PerspectiveCamera, WebGLRenderer, RingGeometry"))).toEqual([]);
    expect(unknownThreeImports(game("GLTFLoader, MeshoptDecoder"))).toEqual([]);
  });

  it("the grown vocabulary (Shape, ShapeGeometry, DoubleSide) is legal", () => {
    expect(unknownThreeImports(game("Shape, ShapeGeometry, DoubleSide"))).toEqual([]);
  });

  it("checks the ORIGINAL name behind an alias, handles multiline imports and multiple statements", () => {
    const html =
      `<script type="module">import {\n  Scene,\n  FancyThing as F\n} from "three";\n` +
      `import { Mesh } from 'three';\nimport { Whatever } from "othermod";</script>`;
    expect(unknownThreeImports(html)).toEqual(["FancyThing"]);
  });

  it("ignores namespace imports (import * as THREE cannot crash the import line)", () => {
    expect(unknownThreeImports(`<script type="module">import * as THREE from "three";</script>`)).toEqual([]);
  });

  it("empty/no-three html is clean, and duplicates report once", () => {
    expect(unknownThreeImports("<html><body>2d game</body></html>")).toEqual([]);
    expect(unknownThreeImports(game("Bogus, Bogus"))).toEqual(["Bogus"]);
  });
});

describe("newUnknownThreeImports (patch gate)", () => {
  it("flags only violations the patch INTRODUCED — a pre-existing one doesn't fail an unrelated patch", () => {
    const before = game("Scene, LegacyBad");
    const after = game("Scene, LegacyBad, FreshBad");
    expect(newUnknownThreeImports(before, after)).toEqual(["FreshBad"]);
    expect(newUnknownThreeImports(before, before)).toEqual([]);
  });
});
