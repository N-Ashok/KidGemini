// 2026-08-25 PRD_EditTurnCost §4.A2: the game the model re-reads on every edit
// turn is the DELIVERED document — the kid's ~12k chars of code plus ~35k chars
// of runtime we inject at delivery (loadModel helper, GL guard, perf probe,
// frame governor, AR_* tables, import map). That runtime is byte-identical
// boilerplate the model neither needs nor may edit, re-billed at the full
// input rate on every turn (measured: ~60% of an edit-turn prompt). The model
// view strips exactly what injection adds, and nothing the child wrote.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { modelViewOf } from "./model-view";
import { injectAssets } from "./inject";
import { ensureAssetRuntime } from "./ensure-runtime";

const KID_3D = `<!doctype html><html><head><title>Tower</title></head><body>
<!--USES_THREE--><!--USES_MODELS:soccer_ball-->
<canvas id="c"></canvas>
<script type="module">
  import { Scene, PerspectiveCamera } from "three";
  // --- SETUP ---
  const scene = new Scene();
  if (typeof window.loadModel === 'function') { loadModel("soccer_ball").then((m) => m && scene.add(m)); }
  // --- LOOP ---
  function loop() { requestAnimationFrame(loop); }
  loop();
</script>
</body></html>`;

const KID_2D = `<!doctype html><html><body><canvas id="c"></canvas><script>
// --- BALL ---
let x = 0; function loop() { x++; requestAnimationFrame(loop); } loop();
</script></body></html>`;

function deliver(raw: string): string {
  return ensureAssetRuntime(injectAssets(raw).html);
}

describe("modelViewOf — the game as the model should read it (delivered runtime stripped)", () => {
  it("MV.1 strips every injected runtime block from a delivered 3D game", () => {
    const delivered = deliver(KID_3D);
    // sanity: delivery really did inject
    expect(delivered).toContain("__arGlGuard");
    expect(delivered).toContain("__arFrameGovernor");
    expect(delivered).toMatch(/window\.loadModel\s*=(?!=)/);
    expect(delivered).toContain('type="importmap"');
    const view = modelViewOf(delivered);
    for (const sig of ["__arGlGuard", "__arFrameGovernor", "__arPerfProbeVersion", "window.AR_ASSETS=", "window.AR_SIZES=", 'type="importmap"', "ari-3d-canvas-floor", 'getElementById("ar-credits")']) {
      expect(view, sig).not.toContain(sig);
    }
    expect(view).not.toMatch(/window\.loadModel\s*=(?!=)/);
    // and it is dramatically smaller — the whole point
    expect(view.length).toBeLessThan(delivered.length / 2);
  });

  it("MV.2 keeps the child's code byte-for-byte — including a script that MENTIONS loadModel (the === guard, BUG-FIX-LOG 2026-08-20)", () => {
    const view = modelViewOf(deliver(KID_3D));
    expect(view).toContain("typeof window.loadModel === 'function'");
    expect(view).toContain("// --- SETUP ---");
    expect(view).toContain("// --- LOOP ---");
    expect(view).toContain('import { Scene, PerspectiveCamera } from "three";');
  });

  it("MV.3 every line the child wrote exists verbatim in BOTH the view and the delivered document (a SEARCH copied from the view matches the source applyPatch patches)", () => {
    const delivered = deliver(KID_3D);
    const view = modelViewOf(delivered);
    // Injection appends its blocks as one run inside <head>; the child's own
    // lines are never split, so a SEARCH copied from the view lands in the
    // delivered source. (A SEARCH that spanned the <head> seam would soft-fail
    // like any other miss — the model is told to anchor on landmark comments.)
    // The <head> line IS the seam (delivery injects there) and USES_ markers
    // are stripped by injection itself — everything else must match.
    const kidLines = KID_3D.split("\n").filter((l) => l.trim() && !l.includes("<!--USES_") && !l.includes("<head>"));
    for (const line of kidLines) {
      expect(view, line).toContain(line);
      expect(delivered, line).toContain(line);
    }
  });

  it("MV.4 a plain 2D game is returned byte-identical", () => {
    const delivered = deliver(KID_2D);
    expect(delivered).toBe(KID_2D); // nothing injected for 2D
    expect(modelViewOf(delivered)).toBe(KID_2D);
  });

  it("MV.5 idempotent, and re-delivery of the view reproduces the runtime", () => {
    const view = modelViewOf(deliver(KID_3D));
    expect(modelViewOf(view)).toBe(view);
    const redelivered = deliver(view);
    expect(redelivered).toContain("__arGlGuard");
    expect(redelivered).toContain('type="importmap"');
    expect(redelivered).toMatch(/window\.loadModel\s*=(?!=)/);
  });
});
