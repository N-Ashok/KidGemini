// Stripping our injected runtime from the copy the model reads (2026-08-16).
//
// The happy path is trivial; these are the ways it can hurt a child.
//
// THE ONE THAT MATTERS: an edit is a SEARCH/REPLACE patch, and applyPatch
// matches the model's SEARCH text against the STORED html. If stripping alters
// a single byte of the child's own code, every patch quoting that line misses
// with `search_not_found` and the child silently loses their edit. So the
// central property is not "does it remove our stuff" but "does the child's
// code survive byte-identical".
import { describe, it, expect } from "vitest";
import { stripInjectedRuntime, isInjectedBlock, strippedTokenSaving } from "./strip-runtime";
import { ensureAssetRuntime } from "./ensure-runtime";
import { applyPatch } from "@/lib/repair-prompt";

/** A game that uses the library, written the way the model writes them. */
const GAME_SCRIPT = `<script type="module">
import { Scene, PerspectiveCamera, WebGLRenderer } from "three";
// --- PLAYER MOVEMENT ---
const scene = new Scene();
const car = await placeModel("car", { at: { x: 0, z: 0 }, heading: "+z" });
scene.add(car);
const trees = await loadModelBatch("tree", 40);
car.rotation.y = modelHeading("car", state.heading);
function tick() { requestAnimationFrame(tick); }
</script>`;
const GAME_MARKUP = `<style>body{margin:0}#hud{color:#fff}</style><div id="hud">Score: 0</div>`;

const stored = (extra = "") =>
  ensureAssetRuntime(`<!DOCTYPE html><html><head><title>Racer</title></head><body>${GAME_MARKUP}${extra}${GAME_SCRIPT}</body></html>`);

describe("the child's code survives byte-identical", () => {
  it("keeps the game's own module script exactly as written", () => {
    const out = stripInjectedRuntime(stored());
    expect(out).toContain(GAME_SCRIPT);
  });

  it("keeps a game script that CALLS loadModel/placeModel/modelHeading", () => {
    // The signatures must key on ASSIGNMENT, never on a mention — every
    // modern game calls these constantly, and dropping the game's own script
    // would be catastrophic.
    const out = stripInjectedRuntime(stored());
    expect(out).toContain('placeModel("car"');
    expect(out).toContain('loadModelBatch("tree", 40)');
    expect(out).toContain('modelHeading("car"');
  });

  it("keeps the child's markup, HUD and styles", () => {
    const out = stripInjectedRuntime(stored());
    expect(out).toContain('<div id="hud">Score: 0</div>');
    expect(out).toContain("body{margin:0}");
  });

  it("keeps landmark comments — SEARCH blocks are anchored on them", () => {
    expect(stripInjectedRuntime(stored())).toContain("// --- PLAYER MOVEMENT ---");
  });

  it("preserves every line of the game verbatim, not merely 'contains'", () => {
    const out = stripInjectedRuntime(stored());
    for (const line of GAME_SCRIPT.split("\n").filter((l) => l.trim())) {
      expect(out).toContain(line);
    }
  });
});

describe("our injected runtime is removed", () => {
  const out = stripInjectedRuntime(stored());

  for (const [what, needle] of [
    ["loadModel helper", "window.loadModel ="],
    ["asset table", "window.AR_ASSETS="],
    ["size table", "window.AR_SIZES="],
    ["facing table", "window.AR_FACING="],
    ["WebGL guard", "window.__arGlGuard"],
    ["frame governor", "window.__arFrameGovernor"],
    ["resolution governor", "window.__arResGovernor"],
    ["perf probe", "window.__arPerfProbeVersion"],
    ["import map", 'type="importmap"'],
  ] as const) {
    it(`removes the ${what}`, () => expect(out).not.toContain(needle));
  }

  it("saves a large, real number of tokens", () => {
    // Measured on real stored games: ~8,400 tokens of a ~21,000-token edit.
    expect(strippedTokenSaving(stored())).toBeGreaterThan(1_000);
  });
});

describe("round trip — the game must still be deliverable", () => {
  it("re-flooring a stripped game restores everything needed to run", () => {
    const refloored = ensureAssetRuntime(stripInjectedRuntime(stored()));
    expect(refloored).toContain('type="importmap"');
    expect(refloored).toContain("window.loadModel =");
    expect(refloored).toContain("window.AR_ASSETS=");
    expect(refloored).toContain("window.__arGlGuard");
    expect(refloored).toContain(GAME_SCRIPT);
  });

  it("strip → floor → strip is stable (idempotent both ways)", () => {
    const once = stripInjectedRuntime(stored());
    expect(stripInjectedRuntime(once)).toBe(once);
    const refloored = ensureAssetRuntime(once);
    expect(stripInjectedRuntime(refloored)).toBe(once);
  });
});

describe("hostile and degenerate input — must never throw or eat the game", () => {
  it("empty and whitespace input", () => {
    expect(stripInjectedRuntime("")).toBe("");
    expect(stripInjectedRuntime("   ")).toBe("   ");
  });

  it("a plain 2D game with no injected runtime at all is untouched", () => {
    const plain = `<!DOCTYPE html><html><body><canvas></canvas><script>const c = 1;</script></body></html>`;
    expect(stripInjectedRuntime(plain)).toBe(plain);
  });

  it("html with no scripts", () => {
    const doc = "<!DOCTYPE html><html><body><p>hello</p></body></html>";
    expect(stripInjectedRuntime(doc)).toBe(doc);
  });

  it("a game whose own code MENTIONS a table name in a string or comment", () => {
    // A game printing a debug line about AR_ASSETS must not be deleted.
    const game = `<script type="module">console.log("checking window.AR_ASSETS keys"); // window.AR_SIZES lookup\n</script>`;
    const out = stripInjectedRuntime(`<html><body>${game}</body></html>`);
    expect(out).toContain(game);
  });

  it("a game that reads a table (not assigns it) is kept", () => {
    const game = `<script type="module">const url = window.AR_ASSETS["car"]; const s = window.AR_SIZES["tree"];</script>`;
    expect(stripInjectedRuntime(`<html><body>${game}</body></html>`)).toContain(game);
  });

  it("truncated html (a cut-off document) does not throw and keeps what is there", () => {
    const cut = `<!DOCTYPE html><html><body><div id="hud">Score`;
    expect(() => stripInjectedRuntime(cut)).not.toThrow();
    expect(stripInjectedRuntime(cut)).toContain('<div id="hud">Score');
  });

  it("an unclosed script tag is left alone rather than swallowing the rest", () => {
    // A non-greedy block regex simply will not match, so nothing is removed —
    // the fail-soft direction.
    const broken = `<html><body><script type="module">const a = 1;`;
    expect(stripInjectedRuntime(broken)).toContain("const a = 1;");
  });

  it("duplicated injected blocks (a stored game floored twice) all go", () => {
    const doubled = stored() + stored();
    const out = stripInjectedRuntime(doubled);
    expect(out).not.toContain("window.loadModel =");
    expect(out).not.toContain("window.AR_ASSETS=");
  });

  it("survives a very large game without pathological slowness", () => {
    const big = stored(`<script type="module">${"const x = 1;\n".repeat(20_000)}</script>`);
    const t0 = Date.now();
    const out = stripInjectedRuntime(big);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(out).toContain("const x = 1;");
  });

  it("SCRIPT/STYLE in any case, with attributes, is still matched", () => {
    const upper = `<SCRIPT TYPE="module">window.AR_ASSETS={"car":"u"};</SCRIPT>`;
    expect(stripInjectedRuntime(`<html><body>${upper}</body></html>`)).not.toContain("AR_ASSETS=");
  });
});

describe("isInjectedBlock — the classifier itself", () => {
  it("says yes to a helper definition and no to a helper call", () => {
    expect(isInjectedBlock(`<script>window.loadModel = async function (n) {}</script>`)).toBe(true);
    expect(isInjectedBlock(`<script type="module">const c = await loadModel("car");</script>`)).toBe(false);
  });

  it("says yes to a table assignment and no to a table read", () => {
    expect(isInjectedBlock(`<script>window.AR_SIZES={"car":[1,2,3]};</script>`)).toBe(true);
    expect(isInjectedBlock(`<script>const s = window.AR_SIZES["car"];</script>`)).toBe(false);
  });

  it("says no to an ordinary game script", () => {
    expect(isInjectedBlock(GAME_SCRIPT)).toBe(false);
  });
});

describe("the patch round trip — the property a child's edit depends on", () => {
  // The model READS the stripped copy and quotes lines from it into a SEARCH
  // block. applyPatch then runs that block against the STORED html, which
  // still contains our runtime. If stripping had altered the game by even a
  // byte, this is where a child silently loses their edit.
  const storedHtml = stored();
  const modelSees = stripInjectedRuntime(storedHtml);

  it("a SEARCH block quoted from the stripped copy applies to the STORED html", () => {
    // Quote a real line the way the model would, anchored on the landmark.
    const search = `// --- PLAYER MOVEMENT ---\nconst scene = new Scene();`;
    expect(modelSees).toContain(search); // the model can see it…
    const reply = [
      "Made the scene!",
      "<<<<<<< SEARCH",
      search,
      "=======",
      `// --- PLAYER MOVEMENT ---\nconst scene = new Scene();\nscene.fog = null;`,
      ">>>>>>> REPLACE",
    ].join("\n");
    const applied = applyPatch(storedHtml, reply); // …and it lands on the stored file
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.html).toContain("scene.fog = null;");
      // and the runtime the child needs is still in the patched result
      expect(applied.html).toContain("window.loadModel =");
    }
  });

  it("every non-trivial game line the model can see also exists in the stored html", () => {
    // The general form of the property above: anything quotable is matchable.
    const gameLines = modelSees
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 12 && !l.startsWith("<") && !l.startsWith("```"));
    expect(gameLines.length).toBeGreaterThan(3);
    for (const line of gameLines) expect(storedHtml).toContain(line);
  });
});
