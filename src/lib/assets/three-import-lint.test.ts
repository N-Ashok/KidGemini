// Deterministic three-import lint (BUG-FIX-LOG 2026-07-20 "DoubleSide"): a
// generated game importing a name the vendored bundle doesn't export dies on
// its import line — the whole game script never runs. The lint catches the
// violation server-side, BEFORE the kid ever sees a dead game.
import { describe, it, expect } from "vitest";
import {
  danglingModuleSpecifiers,
  ensureThreeImports,
  externalScriptSrcs,
  newDanglingModuleSpecifiers,
  newExternalScriptSrcs,
  newUnknownThreeImports,
  unknownThreeImports,
  stripRuntimeGlobalImports,
} from "./three-import-lint";

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

// ── The BYPASS defect: the game never joins the pipeline at all ──────────────
// BUG_LOG 2026-08-09 (Calvin). A generated 3D game skipped the whole vendored
// contract — no `<!--USES_THREE-->` marker, no import map, no `from "three"` —
// and instead loaded three.js r128 off cdnjs with a legacy global <script src>.
// r128 predates CapsuleGeometry, so `new THREE.CapsuleGeometry(...)` threw
// "is not a constructor", init() died on the line building the child's own
// character, and the kid got a blank screen after a ~70s wait.
//
// EVERY existing guard passed: unknownThreeImports() only matches
// `import {...} from "three"` and there was no ES import to match; asset
// injection keys off the USES_THREE marker, which was absent; the import-map
// ordering fix has no map to order. The lint's own comment had waved this
// class through as benign ("legacy unpkg URLs pass through byte-identical").
// It is not benign — it is a silent bypass of the vendored engine, and it
// makes a published game depend on a third-party CDN staying up.
const cdnGame = (src: string) =>
  `<html><body><canvas id="c"></canvas>\n<script src="${src}"></script>\n<script>const s = new THREE.Scene();</script></body></html>`;

describe("externalScriptSrcs (pipeline-bypass lint)", () => {
  it("flags the exact tag that broke Calvin's game", () => {
    const html = cdnGame("https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js");
    expect(externalScriptSrcs(html)).toEqual(["https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"]);
  });

  it("flags the other CDNs the model reaches for, and protocol-relative URLs", () => {
    expect(externalScriptSrcs(cdnGame("https://unpkg.com/three@0.150.0/build/three.min.js"))).toHaveLength(1);
    expect(externalScriptSrcs(cdnGame("https://cdn.jsdelivr.net/npm/three/build/three.js"))).toHaveLength(1);
    expect(externalScriptSrcs(cdnGame("http://threejs.org/build/three.js"))).toHaveLength(1);
    expect(externalScriptSrcs(cdnGame("//unpkg.com/tone/build/Tone.js"))).toHaveLength(1);
  });

  it("is NOT three-specific — any off-origin script is a bypass", () => {
    expect(externalScriptSrcs(cdnGame("https://cdn.jsdelivr.net/npm/tone@14/build/Tone.js"))).toHaveLength(1);
    expect(externalScriptSrcs(cdnGame("https://code.jquery.com/jquery-3.7.1.min.js"))).toHaveLength(1);
  });

  it("leaves a correct pipeline game alone: inline scripts, the asset host, and relative srcs", () => {
    const good =
      `<html><body><!--USES_THREE-->\n<canvas id="scene"></canvas>\n` +
      `<script type="importmap">{"imports":{"three":"https://assets.ariantra.com/three.098b4c.js"}}</script>\n` +
      `<script type="module">import { Scene, CapsuleGeometry } from "three";</script>\n` +
      `<script src="https://assets.ariantra.com/three.098b4c.js"></script>\n` +
      `<script src="/sdk.js"></script></body></html>`;
    expect(externalScriptSrcs(good)).toEqual([]);
    expect(externalScriptSrcs("<html><body>plain 2d game</body></html>")).toEqual([]);
  });

  it("handles single quotes, extra attributes, and reports each URL once", () => {
    const html =
      `<script defer src='https://cdnjs.cloudflare.com/a.js' crossorigin></script>` +
      `<script src="https://cdnjs.cloudflare.com/a.js"></script>`;
    expect(externalScriptSrcs(html)).toEqual(["https://cdnjs.cloudflare.com/a.js"]);
  });
});

// The THIRD bypass shape, found by running all 312 stored conversations
// through the browser harness while measuring Calvin's blast radius
// (BUG_LOG 2026-08-09). A car-racing game invented a LOCAL FILE LAYOUT — a
// multi-file three.js checkout that has never existed in a single-document
// game — and died with `Failed to resolve module specifier
// "./three.module.js"`. Same family as Calvin's (the game never joined the
// vendored contract), different mechanism: relative specifiers to files that
// do not exist. Neither lint above sees it — a relative src is not an
// external script, and NAMED_IMPORT_RE only inspects `from "three"`.
const relImportGame = (spec: string) =>
  `<html><body><script type="module">import * as THREE from '${spec}';</script></body></html>`;

describe("danglingModuleSpecifiers (pipeline-bypass lint, relative form)", () => {
  it("flags the exact specifiers that broke the stored car-racing game", () => {
    const html =
      `<html><body><script type="module">\n` +
      `import * as THREE from './three.module.js';\n` +
      `import { GLTFLoader } from './jsm/loaders/GLTFLoader.js';\n` +
      `import './main.js';\n</script></body></html>`;
    expect(danglingModuleSpecifiers(html)).toEqual([
      "./three.module.js",
      "./jsm/loaders/GLTFLoader.js",
      "./main.js",
    ]);
  });

  it("passes the ONLY specifier a generated game may import", () => {
    expect(danglingModuleSpecifiers(relImportGame("three"))).toEqual([]);
    expect(danglingModuleSpecifiers(`<script type="module">import { Scene } from "three";</script>`)).toEqual([]);
  });

  it("passes the asset host, and flags any other absolute URL", () => {
    expect(danglingModuleSpecifiers(relImportGame("https://assets.ariantra.com/three.098b4c.js"))).toEqual([]);
    expect(danglingModuleSpecifiers(relImportGame("https://unpkg.com/three/build/three.module.js"))).toHaveLength(1);
  });

  it("covers bare, parent-relative and root-relative forms, and reports once", () => {
    expect(danglingModuleSpecifiers(relImportGame("../lib/three.js"))).toEqual(["../lib/three.js"]);
    expect(danglingModuleSpecifiers(relImportGame("/vendor/three.js"))).toEqual(["/vendor/three.js"]);
    expect(danglingModuleSpecifiers(relImportGame("three/examples/jsm/controls/OrbitControls.js"))).toHaveLength(1);
    const twice = relImportGame("./main.js") + relImportGame("./main.js");
    expect(danglingModuleSpecifiers(twice)).toEqual(["./main.js"]);
  });

  it("ignores a 2D game with no module imports at all", () => {
    expect(danglingModuleSpecifiers("<html><body><canvas></canvas></body></html>")).toEqual([]);
  });
});

describe("newExternalScriptSrcs (patch gate)", () => {
  it("flags only what the patch ADDED — a pre-existing CDN game can still be edited", () => {
    const before = cdnGame("https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js");
    const after = before.replace("</body>", `<script src="https://unpkg.com/tone/build/Tone.js"></script></body>`);
    expect(newExternalScriptSrcs(before, after)).toEqual(["https://unpkg.com/tone/build/Tone.js"]);
    expect(newExternalScriptSrcs(before, before)).toEqual([]);
  });

  it("newDanglingModuleSpecifiers judges only what the patch ADDED", () => {
    const before = relImportGame("./three.module.js");
    const after = before.replace("</script>", `import './physics.js';</script>`);
    expect(newDanglingModuleSpecifiers(before, after)).toEqual(["./physics.js"]);
    expect(newDanglingModuleSpecifiers(before, before)).toEqual([]);
  });
});

// BUG-FIX-LOG 2026-08-07 (PointLight addendum) — the MIRROR defect of the
// import lint above: a name USED (`new PointLight(...)`) but missing from the
// game's `import { ... } from "three"` list. ReferenceError at play time, in
// the sandbox AND published, while the pre-delivery check said "clean"
// (nothing executes spawnPickup until a pickup spawns). Deterministic heal:
// append the missing name to the game's own import list — but ONLY names the
// vendored bundle actually exports, or the heal itself would create the
// import-line crash unknownThreeImports() exists to catch.
const playable = (imports: string, body: string) =>
  `<html><body><script type="module">import { ${imports} } from "three";\n${body}</script></body></html>`;

describe("ensureThreeImports (used-but-not-imported heal)", () => {
  it("adds a missing constructor name to the import list (the real PointLight bug shape)", () => {
    const html = playable("Scene, Mesh, AmbientLight, DirectionalLight, MathUtils", "const light = new PointLight(0xff0000, 5, 10);");
    const out = ensureThreeImports(html);
    expect(out).toContain('import { Scene, Mesh, AmbientLight, DirectionalLight, MathUtils, PointLight } from "three"');
    expect(out).toContain("new PointLight(0xff0000, 5, 10)"); // body untouched
  });

  it("byte-identical when every used name is already imported", () => {
    const html = playable("Scene, PointLight", "const l = new PointLight(1); const s = new Scene();");
    expect(ensureThreeImports(html)).toBe(html);
  });

  it("byte-identical with no three import at all — non-three and legacy unpkg games are out of scope", () => {
    const plain = `<html><body><script>const x = new PointLight(1);</script></body></html>`;
    expect(ensureThreeImports(plain)).toBe(plain);
    const unpkg = `<html><body><script type="module">import { Scene } from "https://unpkg.com/three@0.128.0/build/three.module.js"; new PointLight(1);</script></body></html>`;
    expect(ensureThreeImports(unpkg)).toBe(unpkg);
  });

  it("never adds a name the game declares itself", () => {
    for (const decl of ["class PointLight {}", "function PointLight() {}", "const PointLight = makeLight();", "let PointLight;", "var PointLight = 1;"]) {
      const html = playable("Scene", `${decl}\nconst l = new PointLight(1);`);
      expect(ensureThreeImports(html)).toBe(html);
    }
  });

  it("ignores namespaced THREE.PointLight — only a bare identifier needs a binding", () => {
    const html = playable("Scene", "const l = new THREE.PointLight(1);");
    expect(ensureThreeImports(html)).toBe(html);
  });

  it("never adds names outside the curated bundle exports — game classes and unvendored three classes alike", () => {
    const html = playable("Scene", "const e = new EnemyTank(1); const s = new SpotLight(2); const t = new TubeGeometry(3);");
    expect(ensureThreeImports(html)).toBe(html); // SpotLight/TubeGeometry aren't vendored — adding them would crash the import line
  });

  it("counts aliased imports by their LOCAL binding", () => {
    const html = playable("PointLight as PL", "const l = new PL(1);");
    expect(ensureThreeImports(html)).toBe(html);
  });

  it("collects bindings across ALL three import statements, healing only the first", () => {
    const html = `<html><body>
<script type="module">import { Scene } from "three"; window.a = new Scene();</script>
<script type="module">import { Mesh } from "three"; window.b = new Mesh(); window.c = new HemisphereLight(1);</script>
</body></html>`;
    const out = ensureThreeImports(html);
    expect(out).toContain('import { Scene, HemisphereLight } from "three"');
    expect(out).toContain('import { Mesh } from "three"');
  });

  it("handles single-quoted specifiers and multi-line import lists", () => {
    const html = `<html><body><script type="module">
import {
    Scene, PerspectiveCamera,
    WebGLRenderer
} from 'three';
const l = new HemisphereLight(1);
</script></body></html>`;
    const out = ensureThreeImports(html);
    expect(out).toContain("WebGLRenderer, HemisphereLight");
    expect(out).toContain("} from 'three'");
  });

  it("adds MathUtils on static usage (MathUtils.clamp) — the one non-constructor name games reach for", () => {
    const html = playable("Scene", "const v = MathUtils.clamp(x, 0, 1);");
    expect(ensureThreeImports(html)).toContain('import { Scene, MathUtils } from "three"');
  });
});

// ── Runtime globals wrongly imported from "three" (BUG-FIX-LOG 2026-08-08) ──
// Prod: `unknown three imports: loadModel, loadModelBatch — corrective retry`.
// These are helpers Ari itself injects as window globals (loadModelHelper etc.),
// and the prompt says to call them as built-ins — so importing them from "three"
// is a category error that kills the import line, and cost a full ~50s corrective
// LLM retry. Stripping them is deterministic and safe: they resolve at runtime.
describe("stripRuntimeGlobalImports — runtime helpers are globals, never three exports", () => {
  it("strips loadModel/loadModelBatch while keeping the real three names", () => {
    const html = `<script type="module">import { Scene, loadModel, WebGLRenderer, loadModelBatch } from "three";</script>`;
    const out = stripRuntimeGlobalImports(html);
    expect(out).toContain('import { Scene, WebGLRenderer } from "three"');
    expect(out).not.toContain("loadModel");
  });

  it("strips every audio/model helper global that actually exists", () => {
    const html = `<script type="module">import { Scene, playSound, playMusic } from "three";</script>`;
    expect(stripRuntimeGlobalImports(html)).toContain('import { Scene } from "three"');
  });

  // The list must never run ahead of the runtime: stripping a name that ISN'T
  // a real global turns a dead import line (loud, verify catches it) into a
  // play-time ReferenceError verify reports as "clean" — the PointLight class,
  // BUG-FIX-LOG 2026-08-07. modelSize was held out until the model-sizing work
  // shipped window.modelSize (2026-08-08); it is a real global now.
  it("strips modelSize now that its window.modelSize helper actually ships", () => {
    const html = `<script type="module">import { Scene, modelSize } from "three";</script>`;
    expect(stripRuntimeGlobalImports(html)).toContain('import { Scene } from "three"');
  });

  it("removes the whole statement when EVERY imported name was a global", () => {
    const html = `<script type="module">import { loadModel, playSound } from "three";\nloadModel("car");</script>`;
    const out = stripRuntimeGlobalImports(html);
    expect(out).not.toMatch(/import\s*\{[^}]*\}\s*from\s*["']three["']/);
    expect(out).toContain('loadModel("car")'); // the CALL is untouched — it's a global
  });

  it("strips an aliased global by its ORIGINAL name", () => {
    const html = `<script type="module">import { Scene, loadModel as lm } from "three";</script>`;
    expect(stripRuntimeGlobalImports(html)).toContain('import { Scene } from "three"');
  });

  it("leaves a clean three import byte-identical", () => {
    const html = `<script type="module">import { Scene, WebGLRenderer } from "three";</script>`;
    expect(stripRuntimeGlobalImports(html)).toBe(html);
  });

  it("is idempotent and 2D-safe (no three import at all)", () => {
    const html = `<script type="module">import { Scene, loadModel } from "three";</script>`;
    const once = stripRuntimeGlobalImports(html);
    expect(stripRuntimeGlobalImports(once)).toBe(once);
    const twoD = `<script>const s = 1;</script>`;
    expect(stripRuntimeGlobalImports(twoD)).toBe(twoD);
  });

  it("clears the very violation the corrective retry fired on — unknownThreeImports goes empty", () => {
    const html = `<script type="module">import { Scene, loadModel, loadModelBatch } from "three";</script>`;
    expect(unknownThreeImports(html)).toEqual(["loadModel", "loadModelBatch"]);
    expect(unknownThreeImports(stripRuntimeGlobalImports(html))).toEqual([]);
  });
});
