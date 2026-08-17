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
import { loadModelHelper, loadModelBatchHelper, audioHelper, INJECTED_RUNTIME_GLOBALS } from "./runtime-helpers";

const game = (imports: string) =>
  `<html><body><script type="module">import { ${imports} } from "three";\nconst x = 1;</script></body></html>`;

describe("unknownThreeImports", () => {
  it("flags names the bundle does not export (the DoubleSide incident, pre-growth)", () => {
    // LatheGeometry / OrbitControls are NOT vendored — classic model drift.
    // (TubeGeometry moved into the bundle 2026-08-17, so it is no longer a
    // valid specimen for this test — the lint must be pinned on a name that
    // is genuinely absent, or it passes for the wrong reason.)
    expect(unknownThreeImports(game("Scene, LatheGeometry"))).toEqual(["LatheGeometry"]);
    expect(unknownThreeImports(game("OrbitControls"))).toEqual(["OrbitControls"]);
  });

  it("passes every curated name, plus the loader module's own imports", () => {
    expect(unknownThreeImports(game("Scene, PerspectiveCamera, WebGLRenderer, RingGeometry"))).toEqual([]);
    expect(unknownThreeImports(game("GLTFLoader, MeshoptDecoder"))).toEqual([]);
  });

  it("the grown vocabulary (Shape, ShapeGeometry, DoubleSide) is legal", () => {
    expect(unknownThreeImports(game("Shape, ShapeGeometry, DoubleSide"))).toEqual([]);
  });

  it("InstancedMesh is legal (2026-08-10) — it was ALWAYS in the served bundle; only this lint blocked it", () => {
    // The AutoRicksaw lesson, second half: the draw-call hint prescribed
    // InstancedMesh, the lint rejected the model's correct patch, and the
    // fallback regeneration REPLACED the child's 89-message game ("the whole
    // game changed and it is pathetic" — owner). The bundle exports it (it
    // backs loadModelBatch); the curated list just never said so.
    expect(unknownThreeImports(game("InstancedMesh"))).toEqual([]);
    // Placement composes via Matrix4 — Object3D/DynamicDrawUsage remain
    // unvendored, and must keep failing until someone vendors them.
    expect(unknownThreeImports(game("Object3D, DynamicDrawUsage"))).toEqual(["Object3D", "DynamicDrawUsage"]);
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

  // REGRESSION (review of the commit that added this lint): the pattern required
  // a quote after `src=`, so an UNQUOTED src — valid HTML the browser loads
  // identically — sailed straight through. Fail-open in the one lint whose
  // entire job is catching the shape that killed Calvin's game.
  it("catches an UNQUOTED src", () => {
    const html = `<script src=https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js></script>`;
    expect(externalScriptSrcs(html)).toEqual(["https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"]);
  });

  // REGRESSION (same review): `startsWith("https://assets.ariantra.com")` has no
  // boundary, so a look-alike host was waved through as our own asset host.
  it("does not mistake a look-alike host for the asset host", () => {
    expect(externalScriptSrcs(cdnGame("https://assets.ariantra.com.cdn-mirror.example/three.js"))).toHaveLength(1);
    expect(externalScriptSrcs(cdnGame("https://assets.ariantra.com-evil.test/three.js"))).toHaveLength(1);
    // ...while the real host, including protocol-relative, still passes.
    expect(externalScriptSrcs(cdnGame("https://assets.ariantra.com/three.098b4c.js"))).toEqual([]);
    expect(externalScriptSrcs(cdnGame("//assets.ariantra.com/three.098b4c.js"))).toEqual([]);
    expect(danglingModuleSpecifiers(relImportGame("//assets.ariantra.com/three.098b4c.js"))).toEqual([]);
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

  it("passes the specifiers a generated game may import", () => {
    expect(danglingModuleSpecifiers(relImportGame("three"))).toEqual([]);
    expect(danglingModuleSpecifiers(`<script type="module">import { Scene } from "three";</script>`)).toEqual([]);
  });

  // REGRESSION, found in review of the commit that added this lint and live in
  // production for one deploy. `cannon-es` is the OTHER legal bare specifier:
  // inject.ts writes `imports["cannon-es"]` into the import map, and
  // physics-playbook.ts teaches `import { World, Body, ... } from "cannon-es"`
  // on EVERY gates.three turn. Allowing only "three" meant every 3D physics
  // game tripped a full corrective regeneration (~50s + the child's Sparks) —
  // and because the corrective prompt says the only legal specifier is "three",
  // a "clean" retry was one that had DROPPED the physics engine.
  it("passes cannon-es — the physics engine is in the import map too", () => {
    expect(danglingModuleSpecifiers(relImportGame("cannon-es"))).toEqual([]);
    const physicsGame =
      `<html><body><!--USES_THREE--><!--USES_PHYSICS-->\n` +
      `<script type="module">import { Scene, Mesh } from "three";\n` +
      `import { World, Body, Vec3, Quaternion } from "cannon-es";</script></body></html>`;
    expect(danglingModuleSpecifiers(physicsGame)).toEqual([]);
    expect(externalScriptSrcs(physicsGame)).toEqual([]);
  });

  // Lockstep: whatever the playbook TEACHES must be what the lint ALLOWS.
  // These drifting apart is the whole defect above, so pin them together.
  it("every specifier the physics playbook teaches is allowed", async () => {
    const { physicsEnginePromptSection } = await import("./physics-playbook");
    const taught = [...physicsEnginePromptSection().matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    expect(taught.length).toBeGreaterThan(0); // the section really does teach an import
    for (const spec of taught) {
      expect(danglingModuleSpecifiers(relImportGame(spec)), spec).toEqual([]);
    }
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
    const html = playable("Scene", "const e = new EnemyTank(1); const s = new SpotLight(2); const t = new LatheGeometry(3);");
    expect(ensureThreeImports(html)).toBe(html); // SpotLight/LatheGeometry aren't vendored — adding them would crash the import line
  });

  it("counts aliased imports by their LOCAL binding", () => {
    const html = playable("PointLight as PL", "const l = new PL(1);");
    expect(ensureThreeImports(html)).toBe(html);
  });

  it("heals EACH module script against its OWN usage — module scripts do not share scope", () => {
    // 2026-08-12 genre-pilot finding: injectAssets inserts its own asset-
    // loader shim as an earlier, separate `<script type="module">`. The old
    // behaviour here ("collect bindings across ALL scripts, heal only the
    // first") patched the WRONG script whenever a later script used a name
    // the first script's import didn't have — the healed name landed in a
    // sibling module that can never see it at runtime, so the game still
    // threw "X is not defined" even though the healer reported nothing wrong.
    // 7 of 15 pipeline games and 2 of 5 Pro games in that pilot broke this
    // exact way. Each script must be healed against its OWN usage only.
    const html = `<html><body>
<script type="module">import { Scene } from "three"; window.a = new Scene();</script>
<script type="module">import { Mesh } from "three"; window.b = new Mesh(); window.c = new HemisphereLight(1);</script>
</body></html>`;
    const out = ensureThreeImports(html);
    expect(out).toContain('import { Scene } from "three"'); // untouched — Scene alone is used here
    expect(out).toContain('import { Mesh, HemisphereLight } from "three"'); // healed — HemisphereLight is used HERE
  });

  it("a name used only in script A is never healed into script B's import, even though B also imports from three", () => {
    const html = `<html><body>
<script type="module">import { GLTFLoader, CylinderGeometry } from "three"; window.loadModel = () => new GLTFLoader();</script>
<script type="module">import { Scene, WebGLRenderer } from "three"; const s = new Scene(); const c = new CylinderGeometry(1, 1, 2);</script>
</body></html>`;
    const out = ensureThreeImports(html);
    // Script 1 already has CylinderGeometry (unused there, but present) — untouched.
    expect(out).toContain('import { GLTFLoader, CylinderGeometry } from "three"');
    // Script 2 actually USES CylinderGeometry but never imported it — must be healed HERE.
    expect(out).toContain('import { Scene, WebGLRenderer, CylinderGeometry } from "three"');
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

  // ── B4: ONE list, and it must not drift from the runtime ───────────────
  //
  // 2026-08-17, KNOWN_BUGS #21. This module kept its own private
  // RUNTIME_GLOBALS of 5 names while runtime-helpers.ts actually injects 13.
  // placeModel, modelHeading and modelFacing were missing — and placeModel is
  // the one prompt-catalog.ts tells the model to PREFER, so it is the name
  // most likely to be imported by mistake. Cost seen live:
  //   ⛔ unknown three imports: loadModel, placeModel, modelHeading
  //      — corrective retry @71804ms
  // a ~50s full regeneration for a fault this healer exists to fix silently.
  // The list now comes from runtime-helpers.ts, which is where the globals are
  // actually defined, so the two cannot drift again.
  it("strips placeModel/modelHeading/modelFacing — the three that were missing", () => {
    const html = `<script type="module">import { Scene, placeModel, modelHeading, modelFacing } from "three";</script>`;
    expect(stripRuntimeGlobalImports(html)).toContain('import { Scene } from "three"');
  });

  it("strips EVERY global the runtime actually injects, and nothing else", () => {
    // The drift guard proper: iterate the shared list rather than a copy of
    // it. A helper added to runtime-helpers.ts without teaching this healer is
    // a ~50s corrective retry per occurrence, so the coupling is the point.
    for (const name of INJECTED_RUNTIME_GLOBALS) {
      const html = `<script type="module">import { Scene, ${name} } from "three";</script>`;
      expect(stripRuntimeGlobalImports(html), `${name} is injected but not stripped`)
        .toContain('import { Scene } from "three"');
    }
    // A real three export must still survive — the PointLight lesson
    // (BUG-FIX-LOG 2026-08-07): stripping a name that is NOT a global turns a
    // loud dead import into a silent play-time ReferenceError.
    expect(INJECTED_RUNTIME_GLOBALS).not.toContain("PointLight");
    expect(INJECTED_RUNTIME_GLOBALS).not.toContain("Scene");
  });

  it("every name in the shared list is really assigned by an injected helper", () => {
    // The other direction of the same coupling, and the one that protects
    // against the PointLight failure mode: a name may only be stripped if the
    // runtime genuinely defines `window.<name> =`.
    const runtime = loadModelHelper() + loadModelBatchHelper() + audioHelper();
    for (const name of INJECTED_RUNTIME_GLOBALS) {
      expect(runtime, `${name} is stripped but never injected`).toMatch(
        new RegExp(`window\\.${name}\\s*=`),
      );
    }
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
