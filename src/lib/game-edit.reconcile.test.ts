// Reproduces the production inSource=false shape (KNOWN_BUGS #5) and proves the
// asset-marker reconciliation rescues it without regressing new-asset edits.
//
// The mechanism (confirmed from code, BUG-FIX-LOG 2026-07-20): injectAssets
// strips `<!--USES_MODELS: …-->` out of the delivered game; the model, told to
// always emit that marker, re-writes it into its SEARCH block; the SEARCH then
// can't be found in the stored (marker-stripped) source, so the patch fails and
// the turn escalates to a full regeneration.
import { describe, expect, it } from "vitest";
import { reconcileAssetMarkers, reconcileAssetMarkersWithReason } from "./game-edit";
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

  // SUPERSEDED 2026-08-08 (BUG-FIX-LOG). This used to assert a bail: a marker
  // naming a new asset was treated as "needs real re-injection", which threw
  // away a working patch and ran a destructive full regeneration. injectAssets
  // already re-injects incrementally (it reclaims the previous AR_ASSETS table
  // and unions it with any markers), so the add only needs its marker literals
  // carried onto the patched html — which is what `markers` now returns.
  it("A.4 reconciles a NEW asset and hands back its marker literals instead of bailing", () => {
    const addsDragon = REPLY.replace(/USES_MODELS: car/g, "USES_MODELS: car, dragon");
    const out = reconcileAssetMarkers(STORED, addsDragon);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/USES_MODELS/); // stripped, so SEARCH matches the stored source
    const detailed = reconcileAssetMarkersWithReason(STORED, addsDragon);
    expect("html" in detailed).toBe(true);
    // The declaration survives — without it injectAssets would never inject
    // "dragon" and the patched game would loadModel() a name that isn't there.
    expect("html" in detailed && detailed.markers).toMatch(/dragon/);
  });

  it("A.4b an edit that adds NOTHING new returns no markers — the common case stays byte-identical", () => {
    const detailed = reconcileAssetMarkersWithReason(STORED, REPLY);
    expect("html" in detailed && detailed.markers).toBe("");
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

// KNOWN_BUGS #5 closeout Step 0 (2026-07-27): logSearchMiss needs to tell,
// from the log alone, WHY reconciliation bailed on a given miss — these
// mirror A.4/A.5/A.6 above but assert the specific reason, not just null.
describe("reconcileAssetMarkersWithReason — bail-reason detail (KNOWN_BUGS #5 Step 0)", () => {
  // SUPERSEDED 2026-08-08: 'new-asset' is no longer a bail reason — see A.4.
  // The type keeps the member so older log lines stay readable.
  it("no longer bails on a new asset — it reconciles and reports the markers to carry", () => {
    const addsDragon = REPLY.replace(/USES_MODELS: car/g, "USES_MODELS: car, dragon");
    const out = reconcileAssetMarkersWithReason(STORED, addsDragon);
    expect(out).not.toHaveProperty("bailed");
    expect("html" in out && out.markers).toMatch(/USES_MODELS/);
  });

  it("bails 'not-injected' when the current game was never run through injectAssets", () => {
    const twoD = "<!doctype html><html><head></head><body><canvas></canvas></body></html>";
    expect(reconcileAssetMarkersWithReason(twoD, REPLY)).toEqual({ bailed: "not-injected" });
  });

  it("bails 'no-marker' when the reply carries no asset marker at all", () => {
    const plain = `Done!
<<<<<<< SEARCH
let carSpeed = 5;
=======
let carSpeed = 9;
>>>>>>> REPLACE`;
    expect(reconcileAssetMarkersWithReason(STORED, plain)).toEqual({ bailed: "no-marker" });
  });

  it("returns the reconciled html (not a bail) on the rescuable common case", () => {
    const result = reconcileAssetMarkersWithReason(STORED, REPLY);
    expect("html" in result).toBe(true);
    expect(result).not.toHaveProperty("bailed");
  });

  it("reconcileAssetMarkers (the existing export) still agrees with the reason variant", () => {
    expect(reconcileAssetMarkers(STORED, REPLY)).toBe(
      (reconcileAssetMarkersWithReason(STORED, REPLY) as { html: string }).html,
    );
  });
});

// The end-to-end guarantee behind A.4 (BUG-FIX-LOG 2026-08-08): reconciling a
// new asset is only safe because injectAssets merges incrementally. This pins
// that contract against the REAL injector — if injectAssets ever stops
// reclaiming the previous AR_ASSETS table, this fails loudly instead of
// silently shipping games whose older models vanished (Sky Patrol bikes class).
describe("new-asset reconciliation survives real injection (end-to-end)", () => {
  const tableOf = (html: string): Record<string, string> => {
    const m = html.match(/window\.AR_ASSETS=(\{.*?\});/);
    return m ? (JSON.parse(m[1]!) as Record<string, string>) : {};
  };

  it("keeps the OLD asset and gains the NEW one in a single merged table", () => {
    // STORED already carries "car". Append the marker route.ts now appends.
    expect(Object.keys(tableOf(STORED))).toContain("car");

    const patched = `${STORED}<!--USES_MODELS: dino-->`;
    const merged = injectAssets(patched).html;

    expect(Object.keys(tableOf(merged)).sort()).toEqual(["car", "dino"]);
    // Exactly ONE table survives — a stale second one would win by document
    // order and erase the model added this turn.
    expect(merged.match(/window\.AR_ASSETS=/g)!.length).toBe(1);
  });
});
