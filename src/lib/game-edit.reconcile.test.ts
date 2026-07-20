// Reproduces the production inSource=false shape (KNOWN_BUGS #5) and proves the
// asset-marker reconciliation rescues it without regressing new-asset edits.
//
// The mechanism (confirmed from code, BUG-FIX-LOG 2026-07-20): injectAssets
// strips `<!--USES_MODELS: …-->` out of the delivered game; the model, told to
// always emit that marker, re-writes it into its SEARCH block; the SEARCH then
// can't be found in the stored (marker-stripped) source, so the patch fails and
// the turn escalates to a full regeneration.
import { describe, expect, it } from "vitest";
import { reconcileAssetMarkers } from "./game-edit";
import { applyPatch } from "./repair-prompt";
import { injectAssets } from "./assets/inject";

// A real 3D game as GENERATED (with the marker), and as STORED (after injection
// strips the marker and adds the import map / AR_ASSETS). "car" resolves in the
// bundled manifest, so injection keeps it.
const RAW = `<!doctype html><html><head></head><body>
<!--USES_MODELS: car-->
<canvas id="c"></canvas>
<script type="module">
let carSpeed = 5;
</script>
</body></html>`;
const STORED = injectAssets(RAW).html;

// The model's edit reply: one prose line, then a SEARCH that re-emits the marker
// it was told to always write — exactly what makes SEARCH un-findable in STORED.
const REPLY = `Zoom zoom — your car is faster now! 🏎️
<<<<<<< SEARCH
<!--USES_MODELS: car-->
<canvas id="c"></canvas>
=======
<!--USES_MODELS: car-->
<canvas id="c" class="fast"></canvas>
>>>>>>> REPLACE`;

describe("asset-marker reconciliation (inSource=false rescue)", () => {
  it("A.1 the stored game really has lost its marker (precondition)", () => {
    expect(STORED).not.toContain("USES_MODELS");
    expect(STORED).toContain("window.AR_ASSETS");
    expect(STORED).toContain('<canvas id="c"></canvas>');
  });

  it("A.2 a direct patch fails search_not_found — the model's SEARCH isn't in the stored source", () => {
    const direct = applyPatch(STORED, REPLY);
    expect(direct.ok).toBe(false);
    expect(direct.ok ? "" : direct.reason).toBe("search_not_found");
  });

  it("A.3 reconciliation strips the marker and the patch then applies cleanly", () => {
    const reconciled = reconcileAssetMarkers(STORED, REPLY);
    expect(reconciled).not.toBeNull();
    const retry = applyPatch(STORED, reconciled!);
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.mode).toBe("patch");
    expect(retry.ok && retry.html).toContain('class="fast"');
    // and it did NOT regenerate the whole file
    expect(retry.ok && retry.html).toContain("window.AR_ASSETS");
  });

  it("A.4 refuses to reconcile a NEW asset — that needs real re-injection (regeneration path)", () => {
    const addsDragon = REPLY.replace(/USES_MODELS: car/g, "USES_MODELS: car, dragon");
    // "dragon" is not in the stored game's AR_ASSETS, so stripping the marker
    // would silently drop the child's newly requested model.
    expect(reconcileAssetMarkers(STORED, addsDragon)).toBeNull();
  });

  it("A.5 refuses on a plain 2D game — a marker there is a genuine new request", () => {
    const twoD = "<!doctype html><html><head></head><body><canvas></canvas></body></html>";
    expect(reconcileAssetMarkers(twoD, REPLY)).toBeNull();
  });

  it("A.6 no-op when the reply carries no marker at all", () => {
    const plain = `Done!
<<<<<<< SEARCH
let carSpeed = 5;
=======
let carSpeed = 9;
>>>>>>> REPLACE`;
    expect(reconcileAssetMarkers(STORED, plain)).toBeNull();
  });

  it("A.7 never rescues a patch that was going to fail for a DIFFERENT reason", () => {
    // SEARCH text genuinely absent (not just marker noise) → still unmatchable
    // after stripping, so applyPatch on the reconciled reply still fails. We
    // must not fabricate a match.
    const wrong = `Nope
<<<<<<< SEARCH
<!--USES_MODELS: car-->
this line was never in the game
=======
<!--USES_MODELS: car-->
neither is this
>>>>>>> REPLACE`;
    const reconciled = reconcileAssetMarkers(STORED, wrong);
    // reconciliation is allowed (marker present, car known), but the re-apply
    // still fails — the rescue is honest, not a rubber stamp.
    expect(reconciled).not.toBeNull();
    expect(applyPatch(STORED, reconciled!).ok).toBe(false);
  });
});
