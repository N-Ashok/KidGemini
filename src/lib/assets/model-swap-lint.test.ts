import { describe, it, expect } from "vitest";
import { loadedModelNames, droppedModelNames, unrequestedModelSwaps } from "./model-swap-lint";

/** The real incident (BUG_LOG, 2026-08-17, "Mumbai Flight Simulator"): the
 *  child asked only for the Take Off / Land buttons to work. The model applied
 *  a clean patch that ALSO swapped `airplane` for `spaceship`, and said so —
 *  "I've swapped the plane for a super cool cartoon spaceship since it's one
 *  of my favorite models!". Twenty turns of the child's game were built around
 *  an aeroplane. */
const BEFORE = `<!--USES_THREE-->
<!--USES_MODELS: airplane, skyscraper-->
<script type="module">
loadModel("airplane").then(m => { playerGroup.add(m); });
const batch = await loadModelBatch("skyscraper", 40);
</script>`;

describe("loadedModelNames", () => {
  it("finds both loadModel and loadModelBatch names", () => {
    expect(loadedModelNames(BEFORE).sort()).toEqual(["airplane", "skyscraper"]);
  });

  it("tolerates single quotes and loose spacing", () => {
    expect(loadedModelNames(`loadModel( 'small_plane' )`)).toEqual(["small_plane"]);
  });

  it("returns each name once even when loaded repeatedly", () => {
    expect(loadedModelNames(`loadModel("dog"); loadModel("dog")`)).toEqual(["dog"]);
  });

  it("is empty for a game that loads no models", () => {
    expect(loadedModelNames("<html><body>2d canvas game</body></html>")).toEqual([]);
  });
});

describe("droppedModelNames", () => {
  it("reports a model the patch stopped loading", () => {
    const after = BEFORE.replace(/airplane/g, "spaceship");
    expect(droppedModelNames(BEFORE, after)).toEqual(["airplane"]);
  });

  it("reports nothing when the patch only ADDS a model", () => {
    const after = `${BEFORE}\nloadModel("boat").then(m => scene.add(m));`;
    expect(droppedModelNames(BEFORE, after)).toEqual([]);
  });

  it("reports nothing for a patch that touches no model at all", () => {
    const after = BEFORE.replace("40", "60");
    expect(droppedModelNames(BEFORE, after)).toEqual([]);
  });
});

describe("unrequestedModelSwaps", () => {
  const swapped = BEFORE.replace(/airplane/g, "spaceship");

  it("FIRES on the real incident — the child never mentioned a spaceship", () => {
    expect(
      unrequestedModelSwaps({
        before: BEFORE,
        after: swapped,
        message: "take off and landing are not working. the game should start on the run way",
      }),
    ).toEqual(["airplane"]);
  });

  it("stays silent when the child asked for the new model by name", () => {
    expect(
      unrequestedModelSwaps({ before: BEFORE, after: swapped, message: "turn my plane into a spaceship!" }),
    ).toEqual([]);
  });

  it("stays silent when the child asked for the new model by ALIAS", () => {
    const toJet = BEFORE.replace(/airplane/g, "fighter_jet");
    // `jet` -> `fighter_jet` lives in MODEL_ALIASES.
    expect(unrequestedModelSwaps({ before: BEFORE, after: toJet, message: "make it a jet instead" })).toEqual([]);
  });

  it("stays silent when the child named the new model in MULTI-WORD form", () => {
    const toSmall = BEFORE.replace(/airplane/g, "small_plane");
    expect(
      unrequestedModelSwaps({ before: BEFORE, after: toSmall, message: "can I have a small plane please" }),
    ).toEqual([]);
  });

  it("FIRES when a model is dropped and nothing replaces it", () => {
    const gone = BEFORE.replace(/loadModel\("airplane"\)[^;]*;/, "");
    expect(unrequestedModelSwaps({ before: BEFORE, after: gone, message: "make the buildings taller" })).toEqual([
      "airplane",
    ]);
  });

  it("stays silent when the child explicitly asked to REMOVE that model", () => {
    const gone = BEFORE.replace(/loadModel\("airplane"\)[^;]*;/, "");
    expect(unrequestedModelSwaps({ before: BEFORE, after: gone, message: "remove the airplane" })).toEqual([]);
  });

  it("treats a mere MENTION of the old model as no authorization to drop it", () => {
    // The child talking ABOUT their aeroplane is not a request to replace it —
    // this is the exact phrasing used all through the Mumbai session.
    expect(
      unrequestedModelSwaps({
        before: BEFORE,
        after: swapped,
        message: "the aeroplane should start from the runway in the airport",
      }),
    ).toEqual(["airplane"]);
  });

  it("is silent on an ordinary edit that changes no models", () => {
    const after = BEFORE.replace("40", "60");
    expect(unrequestedModelSwaps({ before: BEFORE, after, message: "more buildings please" })).toEqual([]);
  });

  it("is silent for a 2D game with no models on either side", () => {
    expect(unrequestedModelSwaps({ before: "<html></html>", after: "<html>x</html>", message: "faster" })).toEqual([]);
  });
});
