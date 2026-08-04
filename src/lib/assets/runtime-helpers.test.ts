// docs/2026-07-30_PRD_PreviewPerfPanel.md — loadModelHelper() now also
// records each successful load into the shared window.__arPerf registry
// that perf-probe.ts reads. The helper's actual `window.loadModel` body runs
// inside the iframe against the real "three" module (bare `import ... from
// "three"`), which node:vm can't resolve — so, like the existing
// inject.models.test.ts, the injected-script tests here assert on the
// generated STRING (markup shape), while the pure triangle-counting
// algorithm (countTriangles) is extracted so it gets a REAL executable unit
// test against fake Object3D-shaped fixtures.
import { describe, it, expect } from "vitest";
import { countTriangles, escapeForInlineScript, insertEarly, loadModelHelper, MAX_TRACKED_INSTANCES } from "./runtime-helpers";

// ── countTriangles — pure, executable against fake mesh fixtures ───────────

interface FakeGeometry {
  index?: { count: number } | null;
  attributes?: { position?: { count: number } };
}
interface FakeMesh {
  isMesh?: boolean;
  geometry?: FakeGeometry;
}
function fakeObject(meshes: FakeMesh[]): { traverse: (cb: (child: FakeMesh) => void) => void } {
  return {
    traverse(cb) {
      for (const m of meshes) cb(m);
    },
  };
}

describe("countTriangles — the per-load triangle sum", () => {
  it("counts indexed geometry as index.count / 3", () => {
    const obj = fakeObject([{ isMesh: true, geometry: { index: { count: 300 } } }]);
    expect(countTriangles(obj)).toBe(100);
  });

  it("counts NON-indexed geometry via attributes.position.count / 3 (V.2 test list item)", () => {
    const obj = fakeObject([{ isMesh: true, geometry: { attributes: { position: { count: 900 } } } }]);
    expect(countTriangles(obj)).toBe(300);
  });

  it("sums across multiple meshes in the same loaded object", () => {
    const obj = fakeObject([
      { isMesh: true, geometry: { index: { count: 300 } } },
      { isMesh: true, geometry: { attributes: { position: { count: 300 } } } },
    ]);
    expect(countTriangles(obj)).toBe(200); // 100 + 100
  });

  it("skips non-mesh children and meshes with no geometry (never throws)", () => {
    const obj = fakeObject([{ isMesh: false }, { isMesh: true }, { isMesh: true, geometry: {} }]);
    expect(countTriangles(obj)).toBe(0);
  });

  it("an object with no meshes at all counts zero", () => {
    expect(countTriangles(fakeObject([]))).toBe(0);
  });
});

// ── loadModelHelper() — generated script shape ──────────────────────────────

describe("loadModelHelper — perf-registry recording (generated script shape)", () => {
  const script = loadModelHelper();

  it("initializes window.__arPerf lazily (never clobbers an existing registry)", () => {
    expect(script).toMatch(/window\.__arPerf\s*=\s*window\.__arPerf\s*\|\|/);
  });

  it("records the load under a try/catch — a recording failure can NEVER break the load (fail-soft floor unchanged)", () => {
    // The existing contract: loadModel still returns the object even if
    // telemetry throws. Assert the perf-recording block is wrapped separately
    // from the outer load try/catch that already handles fetch/parse failure.
    const loadFn = script.slice(script.indexOf("window.loadModel"));
    expect(loadFn).toMatch(/try\s*\{[\s\S]*__arPerf[\s\S]*?\}\s*catch/);
  });

  it("still returns null on a failed load (contract unchanged) — no perf write on that path", () => {
    const failBlock = script.slice(script.lastIndexOf("} catch (e) {"));
    expect(failBlock).toMatch(/loadModel failed/);
    expect(failBlock).not.toMatch(/__arPerf/);
  });

  it("populates rootNames (the WeakMap the AnimationMixer wrap keys against)", () => {
    expect(script).toMatch(/rootNames\.set\(/);
  });

  it("bounds the tracked-instances array so a spawn/despawn loop can't grow it forever", () => {
    expect(script).toContain(String(MAX_TRACKED_INSTANCES));
  });

  it("still declares window.loadModel exactly once (helper shape unchanged)", () => {
    expect(script.match(/window\.loadModel\s*=/g)?.length).toBe(1);
  });
});

// escapeForInlineScript — extracted 2026-08-03 from preview-runtime.ts so
// every module that inlines arbitrary content into a <script> block (the
// preview SDK bundle, a kid's save-state JSON) shares one escape.
describe("escapeForInlineScript", () => {
  it("neutralizes a literal </script> so it can't terminate the surrounding tag", () => {
    expect(escapeForInlineScript("var x = '</script>';")).toBe("var x = '<\\/script>';");
  });

  it("is case-insensitive (</SCRIPT>, </Script>)", () => {
    expect(escapeForInlineScript("</SCRIPT>")).toBe("<\\/SCRIPT>");
    expect(escapeForInlineScript("</Script>")).toBe("<\\/Script>");
  });

  it("leaves content with no closing script tag untouched", () => {
    expect(escapeForInlineScript('{"areas":[{"id":"a"}]}')).toBe('{"areas":[{"id":"a"}]}');
  });

  it("escapes every occurrence, not just the first", () => {
    const input = "</script>a</script>b</script>";
    expect(escapeForInlineScript(input).match(/<\\\/script>/gi)?.length).toBe(3);
  });
});

// insertEarly — the shared anchor-cascade (head, else html, else prepend).
describe("insertEarly", () => {
  it("inserts right after <head> when present", () => {
    const out = insertEarly("<html><head><title>t</title></head><body>x</body></html>", "MARK");
    expect(out).toBe("<html><head>MARK<title>t</title></head><body>x</body></html>");
  });

  it("falls back to right after <html> when there is no <head>", () => {
    const out = insertEarly("<html><body>x</body></html>", "MARK");
    expect(out).toBe("<html>MARK<body>x</body></html>");
  });

  it("prepends when there is neither <head> nor <html>", () => {
    expect(insertEarly("<div>bare</div>", "MARK")).toBe("MARK<div>bare</div>");
  });
});
