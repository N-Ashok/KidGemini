import { describe, it, expect } from "vitest";
import { CATEGORY_GUIDE, ALWAYS_HARD_BLOCK } from "./safety.config";

/** Policy decision 2026-07-06 (owner): classic game-genre content — shooters,
 *  sword adventures, cartoon battles — is allowed; the classifier must judge
 *  only REAL/graphic violence and REAL-WORLD dangerous acts. These tests lock
 *  the exemption wording so a future edit can't silently re-block game-making. */
describe("safety policy — game-action exemption", () => {
  it("violence exempts GAME-MAKING, however realistic, and still catches gore/real harm", () => {
    // Widened 2026-08-16 by owner decision: "kids want bullets and guns and
    // it's part of games they play". The carve-out used to cover only CARTOON
    // action, so a child asking for a realistic shooter could be classified as
    // violence and blocked before the model ever saw the request.
    expect(CATEGORY_GUIDE.violence).toMatch(/NOT violence/);
    expect(CATEGORY_GUIDE.violence).toMatch(/guns, bullets, shooting/i);
    expect(CATEGORY_GUIDE.violence).toMatch(/however realistic/i);
    // What the category still means. These are the fail-closed parts.
    expect(CATEGORY_GUIDE.violence).toMatch(/gore/i);
    expect(CATEGORY_GUIDE.violence).toMatch(/REAL people/);
  });

  it("the hard-block core is unchanged by the widening", () => {
    // Widening a carve-out must never touch what always blocks.
    expect(ALWAYS_HARD_BLOCK).toEqual(["sexual", "self_harm", "stranger_contact"]);
  });

  it("dangerous_acts is scoped to the real world, exempting fictional game weapons", () => {
    expect(CATEGORY_GUIDE.dangerous_acts).toMatch(/REAL-WORLD/);
    expect(CATEGORY_GUIDE.dangerous_acts).toMatch(/NOT dangerous acts/);
  });

  it("the always-hard-block list is untouched by the exemption (fail-closed core)", () => {
    expect(ALWAYS_HARD_BLOCK).toEqual(["sexual", "self_harm", "stranger_contact"]);
  });
});
