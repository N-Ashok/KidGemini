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
import {
  countTriangles,
  escapeForInlineScript,
  insertEarly,
  loadModelHelper,
  loadModelBatchHelper,
  LOAD_MODEL_BATCH_VERSION,
  LOAD_MODEL_HELPER_VERSION,
  MAX_TRACKED_INSTANCES,
  parseSizeTables,
  stripSizeTables,
  countSizeTables,
} from "./runtime-helpers";

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

// ── loadModelHelper() — template cache, STATIC MODELS ONLY (2026-08-05, ──
// narrowed same day after a live regression: caching + SkeletonUtils.clone()
// for animated models silently broke skinning on real hosted rigs (legs/arms/
// rotors froze at rest pose) — see the loadModelHelper() doc comment. Animated
// models must get a screenshot-identical script to the ORIGINAL (pre-cache)
// helper: no cache, no clone, no SkeletonUtils, a fresh loadAsync every call.

describe("loadModelHelper — static-model template cache; animated models untouched", () => {
  const script = loadModelHelper();

  it("stamps the injected version so ensure-runtime.ts can detect a stale helper", () => {
    expect(script).toContain(`window.__arLoadModelVersion = ${LOAD_MODEL_HELPER_VERSION};`);
  });

  it("does NOT import or reference SkeletonUtils — the unverified clone path was removed entirely", () => {
    expect(script).not.toMatch(/SkeletonUtils/);
  });

  it("declares a template cache and checks it BEFORE fetching fresh, inside window.loadModel's body", () => {
    expect(script).toMatch(/var __arStaticTemplates\s*=\s*\{\}/);
    const loadModelBody = script.slice(script.indexOf("window.loadModel = async function"));
    const cacheCheckIdx = loadModelBody.indexOf("if (__arStaticTemplates[name]) {");
    const freshCallIdx = loadModelBody.indexOf("__arLoadFresh(name)");
    expect(cacheCheckIdx).toBeGreaterThan(-1);
    expect(freshCallIdx).toBeGreaterThan(-1);
    expect(cacheCheckIdx).toBeLessThan(freshCallIdx);
  });

  it("caches and clones ONLY when the fresh load has no animations", () => {
    expect(script).toMatch(/if \(fresh\.animations\.length\)\s*\{\s*obj = fresh\.scene;/);
    expect(script).toMatch(/\}\s*else\s*\{\s*__arStaticTemplates\[name\] = fresh;\s*obj = fresh\.scene\.clone\(\);/);
  });

  it("an animated model is handed back the pristine freshly-parsed scene — never cloned, never cached", () => {
    expect(script).not.toMatch(/SkeletonUtils\.clone/);
    // The animated branch assigns obj = fresh.scene directly (no .clone()).
    const animatedBranch = script.slice(script.indexOf("if (fresh.animations.length)"), script.indexOf("} else {"));
    expect(animatedBranch).not.toContain(".clone()");
  });

  it("a repeat call for the SAME animated name re-fetches fresh (no caching skip) — same cost as before this whole change", () => {
    // __arStaticTemplates is written to exactly once in the whole script,
    // inside the non-animated branch — an animated name can never populate
    // it, so it can never short-circuit through the cache check on a repeat.
    expect(script.match(/__arStaticTemplates\[name\] = fresh;/g)?.length).toBe(1);
    const writeIdx = script.indexOf("__arStaticTemplates[name] = fresh;");
    const precedingElse = script.slice(Math.max(0, writeIdx - 80), writeIdx);
    expect(precedingElse).toMatch(/\}\s*else\s*\{\s*$/);
  });
});

// ── loadModelBatchHelper() — InstancedMesh pooling for static bulk props ────

describe("loadModelBatchHelper — generated script shape", () => {
  const script = loadModelBatchHelper();

  it("declares window.loadModelBatch exactly once", () => {
    expect(script.match(/window\.loadModelBatch\s*=/g)?.length).toBe(1);
  });

  it("refuses animated models rather than silently mis-batching them", () => {
    expect(script).toMatch(/template\.animations\.length[\s\S]*?does not support animated models/);
  });

  // NOTE (2026-08-15): the three tests below used to pin the script's exact
  // TEXT — `new InstancedMesh(part.geometry, …)` and
  // `box.copy(parts[0].geometry.boundingBox)` — which is how the placement bug
  // survived: they asserted the broken expression as though it were the spec,
  // so they passed for as long as the bug existed and failed the moment it was
  // fixed. Behaviour that regexes cannot see is covered by
  // scripts/check-batch-parity.mts, which compares batched against single
  // placement for every model in a real browser.
  it("creates one InstancedMesh per distinct geometry\\/material part and adds it to a container added once", () => {
    expect(script).toMatch(/new InstancedMesh\(part\.mesh\.geometry, part\.mesh\.material, count\)/);
    expect(script).toMatch(/container\.add\(im\)/);
  });

  it("captures each part's transform INSIDE the model, relative to the model root", () => {
    // Without this, a batched prop loses the node transforms that stand it
    // upright, sit it on the ground and scale it to real-world metres.
    expect(script).toMatch(/template\.scene\.updateMatrixWorld\(true\)/);
    expect(script).toMatch(/rootInverse[\s\S]*?template\.scene\.matrixWorld[\s\S]*?invert\(\)/);
    expect(script).toMatch(/local:\s*new Matrix4\(\)\.multiplyMatrices\(rootInverse, child\.matrixWorld\)/);
  });

  it("setInstance bakes the part transform into the instance matrix and flags it dirty", () => {
    expect(script).toMatch(/matrix\.compose\(__arPos, __arQuat, __arScale\)/);
    // instance transform FIRST, then the part's place within the model.
    expect(script).toMatch(/__arPartMatrix\.multiplyMatrices\(matrix, parts\[m\]\.local\)/);
    expect(script).toMatch(/meshes\[m\]\.setMatrixAt\(i, __arPartMatrix\)/);
    expect(script).toMatch(/meshes\[m\]\.instanceMatrix\.needsUpdate = true/);
  });

  it("boundsAt unions EVERY part, so a multi-part model reports its whole collision box", () => {
    expect(script).toMatch(/boundsAt:\s*function\s*\(i\)/);
    expect(script).toMatch(/box\.makeEmpty\(\)/);
    expect(script).toMatch(/box\.union\(partBox\)/);
  });

  it("exposes modelFacing/modelMetres and a placeModel that uses them", () => {
    // 2026-08-15. Before this the runtime had no facing datum at all and no
    // way to floor a model onto the ground, so every game guessed both.
    const helper = loadModelHelper();
    expect(helper).toMatch(/window\.modelFacing\s*=/);
    expect(helper).toMatch(/window\.modelMetres\s*=/);
    expect(helper).toMatch(/window\.placeModel\s*=/);
    // The heading maths must go through the measured facing, not a constant.
    expect(helper).toMatch(/window\.modelFacing\(name\)/);
    // The ground floor is MEASURED after scale+rotation, not read from a table.
    expect(helper).toMatch(/new Box3\(\)\.setFromObject\(obj\)/);
    expect(helper).toMatch(/obj\.position\.y = groundY - box\.min\.y/);
  });

  it("placeModel leaves rotation alone when the model has no audited facing", () => {
    // A confident wrong turn is worse than no turn: an unaudited model must
    // come out exactly as loadModel would have given it.
    const helper = loadModelHelper();
    expect(helper).toMatch(/if \(a >= 0 && b >= 0\) obj\.rotation\.y/);
  });

  it("placeModel is a NEW api, and loadModel still normalises nothing", () => {
    // Deliberate: stored games hand-compensate for these quirks (one flips a
    // crocodile with rotation.y = Math.PI). Auto-correcting loadModel would
    // flip those games BACK to wrong — see CLAUDE.md rule 11.
    const helper = loadModelHelper();
    const loadModelBody = helper.slice(helper.indexOf("window.loadModel = async"));
    const upToPlace = loadModelBody.slice(0, loadModelBody.indexOf("window.placeModel"));
    expect(upToPlace).not.toMatch(/rotation\.y\s*=/);
    expect(upToPlace).not.toMatch(/position\.y\s*=/);
    expect(upToPlace).not.toMatch(/scale\.(setScalar|multiplyScalar)/);
  });

  it("stamps a version so ensureAssetRuntime can replace a stale copy in a stored game", () => {
    expect(script).toMatch(
      new RegExp(`window\\.__arLoadModelBatchVersion = ${LOAD_MODEL_BATCH_VERSION}`),
    );
  });

  it("fails soft (returns null, warns) rather than throwing on a bad name or a load failure", () => {
    const failBlock = script.slice(script.lastIndexOf("} catch (e) {"));
    expect(failBlock).toMatch(/loadModelBatch failed/);
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

// 2026-08-08, BUG-FIX-LOG fragmented race tracks. The generated racer laid 1 m
// road tiles at 10 m intervals because NOTHING in the runtime could tell it how
// big a tile is. AR_SIZES + modelSize() are that missing channel.
describe("AR_SIZES — the measured-metres table behind modelSize()", () => {
  const block = (t: unknown) => `<script>window.AR_SIZES=${JSON.stringify(t)};</script>`;

  it("parses, counts and strips its own block", () => {
    const html = `<head>${block({ road_straight: [1, 0.02, 1] })}</head><body>go</body>`;
    expect(countSizeTables(html)).toBe(1);
    expect(parseSizeTables(html)).toEqual([{ road_straight: [1, 0.02, 1] }]);
    expect(stripSizeTables(html)).toBe("<head></head><body>go</body>");
  });

  it("returns every table in document order — the duplicate-block case", () => {
    // The 2026-08-06 Sky Patrol failure was a SECOND, stale table winning
    // because it ran later. Detection is what lets the caller collapse them.
    const html = block({ car: [1.3, 0.73, 2.56] }) + "<p>x</p>" + block({ car: [9, 9, 9] });
    expect(countSizeTables(html)).toBe(2);
    expect(parseSizeTables(html)).toEqual([{ car: [1.3, 0.73, 2.56] }, { car: [9, 9, 9] }]);
    expect(stripSizeTables(html)).toBe("<p>x</p>");
  });

  it("skips an unparseable block instead of throwing — a kid's game must survive anything", () => {
    const html = `<script>window.AR_SIZES={not json};</script>${block({ tree: [1.9, 1.9, 1.9] })}`;
    expect(() => parseSizeTables(html)).not.toThrow();
    expect(parseSizeTables(html)).toEqual([{ tree: [1.9, 1.9, 1.9] }]);
  });

  it("does not confuse itself with the AR_ASSETS table", () => {
    const html = `<script>window.AR_ASSETS={"car":"https://x/car.glb"};</script>${block({ car: [1, 1, 1] })}`;
    expect(countSizeTables(html)).toBe(1);
    // Stripping sizes must leave the URL table completely untouched.
    expect(stripSizeTables(html)).toBe(`<script>window.AR_ASSETS={"car":"https://x/car.glb"};</script>`);
  });

  it("keeps array values so the non-greedy block regex still terminates correctly", () => {
    // THE reason sizes ship as a separate table with ARRAY values: the regex
    // family is non-greedy to the first `}`. An object-valued table would
    // truncate the capture and parse to nothing, silently.
    const html = block({ a: [1, 2, 3], b: [4, 5, 6] });
    expect(parseSizeTables(html)).toEqual([{ a: [1, 2, 3], b: [4, 5, 6] }]);
  });
});

describe("loadModelHelper — modelSize(name)", () => {
  const script = loadModelHelper();

  it("defines modelSize exactly once, reading the AR_SIZES table", () => {
    expect(script.match(/window\.modelSize\s*=/g)?.length).toBe(1);
    expect(script).toContain("window.AR_SIZES[name]");
  });

  it("tolerates the table being absent so injection order is never load-bearing", () => {
    expect(script).toContain("window.AR_SIZES = window.AR_SIZES || {}");
  });

  it("stamps the size onto the loaded object as well as answering by name", () => {
    expect(script).toContain("obj.userData.arSize = window.modelSize(name)");
  });

  // 4 → 5 (2026-08-08): the version bump is what retrofits modelAxis() onto
  // ALREADY-STORED games — same mechanism the v4 modelSize bump used.
  // 5 → 6 (2026-08-09): same mechanism again, now carrying modelJoins() and
  // rotateToJoin() to stored games — which IS the migration for the reported
  // broken race track (BUG-FIX-LOG). A child re-opening it gets a model that
  // can finally answer which way a corner turns.
  it("bumped the helper version so stored games get the new accessors retrofitted", () => {
    // Without the bump, ensureAssetRuntime leaves an existing older helper
    // alone and the new capability never reaches any game that already exists.
    // v7: modelSize + modelAxis + modelJoins + fitTile.
    // v8 (2026-08-15): modelFacing + modelMetres + placeModel.
    expect(LOAD_MODEL_HELPER_VERSION).toBe(8);
    expect(script).toContain("window.__arLoadModelVersion = 8");
  });

  it("answers null rather than a made-up number for an unmeasured model", () => {
    // Executable check of the emitted body: skinned models ship no size, and a
    // game that gets null degrades to eyeballing — never to a wrong footprint.
    const body = script.match(/window\.modelSize = function \(name\) \{[\s\S]*?\n\};/)![0];
    const win: Record<string, unknown> = { AR_SIZES: { road_straight: [1, 0.02, 1] } };
    new Function("window", body)(win);
    const modelSize = win.modelSize as (n: string) => unknown;
    expect(modelSize("road_straight")).toEqual({ x: 1, y: 0.02, z: 1 });
    expect(modelSize("dino")).toBeNull();
    expect(modelSize("not_a_model")).toBeNull();
  });
});

// fitTile (v7, 2026-08-09). Added after a generated track picked the RIGHT kit
// and ONE scale factor — both taught successfully — and then hardcoded all four
// corner rotations and got all four wrong. Deriving "this cell needs north and
// east; the piece joins +z/+x at rest; therefore 3pi/2" is four reasoning steps
// under a token budget, and three rounds of prompt teaching failed to land it.
// The calculation belongs in the runtime (TECH_DEBT #97: the fix is not prose).
describe("fitTile — the rotation for a cell, from the directions it connects", () => {
  // Evaluate the shipped helper source the way a browser would, so these test
  // the STRING that actually reaches a game, not a re-implementation.
  function runtime(edges: Record<string, unknown>) {
    // Balanced-brace scan from the assignment to its matching close, so the
    // extraction survives anything else being added to the helper later.
    const helper = loadModelHelper();
    const start = helper.indexOf("window.fitTile = function");
    expect(start, "fitTile must be in the shipped helper").toBeGreaterThan(-1);
    const from = helper.indexOf("{", start);
    let depth = 0;
    let end = from;
    for (let i = from; i < helper.length; i++) {
      if (helper[i] === "{") depth++;
      else if (helper[i] === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    const body = helper.slice(from, end);
    const w: Record<string, unknown> = { AR_EDGES: edges };
    return new Function("window", `return function (name, need) ${body};`)(w) as (
      n: string,
      need: string[],
    ) => number | null;
  }
  const CORNER = { joins: ["+z", "+x"], lane: 0.697 };
  const fit = runtime({ race_track_corner: CORNER, race_track_straight: { joins: ["-z", "+z"] } });
  const Q = Math.PI / 2;

  // The four corners of the 2026-08-09 production track, with the rotation each
  // one actually needed. Every one of these was hardcoded wrong.
  it.each([
    { cell: "top-left     (track N and E)", need: ["-z", "+x"], expected: 3 * Q, wasUsed: 0 },
    { cell: "top-right    (track W and N)", need: ["-x", "-z"], expected: 2 * Q, wasUsed: -Q },
    { cell: "bottom-right (track S and W)", need: ["+z", "-x"], expected: 1 * Q, wasUsed: 2 * Q },
    { cell: "bottom-left  (track E and S)", need: ["+x", "+z"], expected: 0, wasUsed: Q },
  ])("$cell → $expected rad", ({ need, expected, wasUsed }) => {
    expect(fit("race_track_corner", need)).toBeCloseTo(expected, 6);
    expect(fit("race_track_corner", need)).not.toBeCloseTo(wasUsed, 6); // what shipped
  });

  it("is order-insensitive — ['+x','-z'] is the same cell as ['-z','+x']", () => {
    expect(fit("race_track_corner", ["+x", "-z"])).toBeCloseTo(fit("race_track_corner", ["-z", "+x"])!, 6);
  });

  it("returns NULL when no quarter turn works — the wrong PIECE, not a bad angle", () => {
    // A corner can never join two OPPOSITE edges. Answering 0 there would draw
    // a silent gap; null lets a game notice and pick a straight instead.
    expect(fit("race_track_corner", ["-z", "+z"])).toBeNull();
  });

  it("fits a straight too, so one call handles every tile on the grid", () => {
    expect(fit("race_track_straight", ["-z", "+z"])).toBeCloseTo(0, 6);
    expect(fit("race_track_straight", ["-x", "+x"])).toBeCloseTo(Q, 6);
  });

  it("answers 0 for an unmeasured piece rather than throwing — fail-soft floor", () => {
    expect(fit("no_such_tile", ["-z", "+x"])).toBe(0);
    expect(fit("race_track_corner", [])).toBe(0);
  });
});
