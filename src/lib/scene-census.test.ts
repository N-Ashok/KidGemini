// A "make it faster" fix must never empty a child's world (2026-08-16).
//
// Owner: "autofix making the game bad is not acceptable." The proactive fix is
// off, but the tap-to-fix banner sends the same hint, so the guard has to live
// on the RESULT rather than on the trigger.
//
// The test that matters most is the LAST describe block: a correct instancing
// fix — the exact edit the hint asks for — must still be allowed through. A
// guard that blocks the good fix as well as the bad one just means slow games
// forever, so both directions are pinned here.
import { describe, it, expect } from "vitest";
import { sceneCensus, censusRegression, CENSUS_FLOOR_RATIO } from "./scene-census";

const wrap = (body: string) => `<html><body><script type="module">${body}</script></body></html>`;

describe("sceneCensus counts copies in the world, not construction calls", () => {
  it("counts a single load as one", () => {
    expect(sceneCensus(wrap(`const c = await loadModel("car");`)).models).toEqual({ car: 1 });
  });

  it("counts a batch as its count", () => {
    expect(sceneCensus(wrap(`await loadModelBatch("tree", 40);`)).models).toEqual({ tree: 40 });
  });

  it("counts placeModel as one", () => {
    expect(sceneCensus(wrap(`await placeModel("house", { at: p });`)).models).toEqual({ house: 1 });
  });

  it("sums repeated calls for the same model", () => {
    const c = sceneCensus(wrap(`loadModel("tree"); loadModelBatch("tree", 9); placeModel("tree", {});`));
    expect(c.models).toEqual({ tree: 11 });
  });

  it("counts an InstancedMesh by its instance count, and a plain Mesh as one", () => {
    const c = sceneCensus(wrap(`new InstancedMesh(geo, mat, 200); new Mesh(g, m); new Mesh(g2, m2);`));
    expect(c.handBuilt).toBe(202);
  });

  it("totals models and hand-built things together", () => {
    const c = sceneCensus(wrap(`loadModelBatch("tree", 10); new Mesh(g, m);`));
    expect(c.total).toBe(11);
  });

  it("is safe on empty, junk and non-game html", () => {
    for (const input of ["", "   ", "<html></html>", "<p>hello</p>"]) {
      expect(() => sceneCensus(input)).not.toThrow();
      expect(sceneCensus(input).total).toBe(0);
    }
  });

  it("clamps an absurd count so one bad number cannot swamp a comparison", () => {
    expect(sceneCensus(wrap(`loadModelBatch("tree", 99999999);`)).models.tree).toBe(5_000);
  });
});

describe("the failure this exists to stop", () => {
  // "it broke the whole game. all the meshes were gone."
  const before = wrap(`
    const car = await loadModel("car");
    const trees = await loadModelBatch("tree", 40);
    const houses = await loadModelBatch("house", 12);
    for (let i = 0; i < 30; i++) scene.add(new Mesh(geo, mat));
  `);

  it("catches a fix that removed every model", () => {
    const after = wrap(`const ground = new Mesh(geo, mat);`);
    const v = censusRegression(before, after);
    expect(v.regressed).toBe(true);
    expect(v.reason).toContain("car");
    expect(v.reason).toContain("tree");
  });

  it("catches a fix that dropped ONE model the child asked for", () => {
    // She asked for a dinosaur; a tidy-up that removes the dinosaur is not a
    // tidy-up. No threshold needed — absence is absence.
    const after = wrap(`
      const car = await loadModel("car");
      const trees = await loadModelBatch("tree", 40);
      for (let i = 0; i < 30; i++) scene.add(new Mesh(geo, mat));
    `);
    const v = censusRegression(before, after);
    expect(v.regressed).toBe(true);
    expect(v.reason).toContain("house");
  });

  it("catches a scene that shrank far below the floor even with names intact", () => {
    const after = wrap(`
      const car = await loadModel("car");
      const trees = await loadModelBatch("tree", 2);
      const houses = await loadModelBatch("house", 1);
    `);
    expect(censusRegression(before, after).regressed).toBe(true);
  });
});

describe("the fix we actually WANT must get through", () => {
  it("allows instancing: 200 hand-built meshes become one InstancedMesh of 200", () => {
    // This is precisely what buildSlowdownHint asks for. If the guard blocked
    // it, the banner would be useless and every slow game would stay slow.
    const before = wrap(`for (let i = 0; i < 200; i++) scene.add(new Mesh(geo, mat));`);
    const after = wrap(`const m = new InstancedMesh(geo, mat, 200); scene.add(m);`);
    expect(censusRegression(before, after).regressed).toBe(false);
  });

  it("allows loadModelBatch replacing repeated loadModel calls", () => {
    const before = wrap(Array.from({ length: 12 }, () => `await loadModel("tree");`).join("\n"));
    const after = wrap(`await loadModelBatch("tree", 12);`);
    expect(censusRegression(before, after).regressed).toBe(false);
  });

  it("allows a modest trim that stays above the floor", () => {
    const before = wrap(`loadModelBatch("tree", 100);`);
    const after = wrap(`loadModelBatch("tree", ${Math.ceil(100 * CENSUS_FLOOR_RATIO) + 5});`);
    expect(censusRegression(before, after).regressed).toBe(false);
  });

  it("allows an unchanged game", () => {
    const same = wrap(`loadModelBatch("tree", 40); const car = await loadModel("car");`);
    expect(censusRegression(same, same).regressed).toBe(false);
  });

  it("allows a fix that ADDS things", () => {
    const before = wrap(`loadModelBatch("tree", 40);`);
    const after = wrap(`loadModelBatch("tree", 40); const car = await loadModel("car");`);
    expect(censusRegression(before, after).regressed).toBe(false);
  });
});

describe("it does not cry wolf on tiny or unreadable scenes", () => {
  it("a scene below the noise floor is judged only on vanished names", () => {
    // 3 things -> 1 thing is a big ratio drop but a meaningless one.
    const before = wrap(`new Mesh(g, m); new Mesh(g, m); new Mesh(g, m);`);
    const after = wrap(`new Mesh(g, m);`);
    expect(censusRegression(before, after).regressed).toBe(false);
  });

  it("a 2D game with nothing to count never registers a regression", () => {
    const before = `<html><body><canvas></canvas><script>const s = 1;</script></body></html>`;
    const after = `<html><body><canvas></canvas><script>const s = 2;</script></body></html>`;
    expect(censusRegression(before, after).regressed).toBe(false);
  });

  it("never throws on degenerate input in either position", () => {
    for (const [a, b] of [["", ""], ["", wrap("loadModel(\"car\")")], [wrap("loadModel(\"car\")"), ""]] as const) {
      expect(() => censusRegression(a, b)).not.toThrow();
    }
  });

  it("an empty AFTER against a real BEFORE is a regression — the strongest signal there is", () => {
    expect(censusRegression(wrap(`loadModelBatch("tree", 40);`), "").regressed).toBe(true);
  });
});
